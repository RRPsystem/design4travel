import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  CORS_HEADERS,
  GenerateRequestSchema,
  jsonResponse,
  MAX_REQUEST_BODY_BYTES,
  type PatchOp,
  ROUTER_TOOLS,
  SPECIALIST_TOOLS,
  toolCallToPatch,
} from "./schema.ts";
import { buildSystemPrompt } from "./prompts.ts";
import {
  type AnthropicCallFailure,
  type AnthropicCallResult,
  callAnthropic,
  extractAssistantText,
  extractToolUses,
} from "./anthropic.ts";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const DEFAULT_ORCHESTRATOR = "claude-sonnet-5";
const DEFAULT_SPECIALIST = "claude-opus-5";
const PRICING_VERSION = "anthropic-2026-08";

// -----------------------------------------------------------------------------
// Deps
// -----------------------------------------------------------------------------

export interface HandlerDeps {
  makeUserClient: () => SupabaseClient;
  makeAdmin: () => SupabaseClient;
  getAnthropicApiKey: () => string | null;
  getOrchestratorModel: () => string;
  getSpecialistModel: () => string;
  getBetaHeaders: () => string | null;
  /** Nu, in ms. Injectable voor tests. */
  now: () => number;
  /** Fetch-injectie zodat tests kunnen mocken zonder Deno.env te raken. */
  callAnthropic: typeof callAnthropic;
}

// -----------------------------------------------------------------------------
// Body-reader
// -----------------------------------------------------------------------------

type BodyReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" | "malformed_length" };

async function readBoundedBody(
  req: Request,
  maxBytes: number,
): Promise<BodyReadResult> {
  const clHeader = req.headers.get("content-length");
  if (clHeader !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(clHeader)) return { ok: false, reason: "malformed_length" };
    const cl = Number(clHeader);
    if (!Number.isSafeInteger(cl) || cl < 0) return { ok: false, reason: "malformed_length" };
    if (cl > maxBytes) return { ok: false, reason: "too_large" };
  }
  const body = req.body;
  if (body === null) return { ok: true, bytes: new Uint8Array(0) };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return { ok: true, bytes: buf };
}

// -----------------------------------------------------------------------------
// Metrics
// -----------------------------------------------------------------------------

interface MetricRow {
  user_id: string;
  organization_id: string;
  provider: string;
  model: string;
  kind: "router" | "specialist" | "standalone";
  parent_call_id: string | null;
  route_reason: string | null;
  success: boolean;
  error_code: string | null;
  request_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  thinking_tokens: number;
  latency_ms: number;
  provider_cost_microusd: number | null;
  pricing_version: string;
}

/**
 * Insert een metric-rij. Fail-open: bij een fout wordt naar console.error
 * gelogd, maar de AI-response wordt NIET geblokkeerd.
 * Retourneert de id van de rij (voor parent_call_id-koppeling), of null bij
 * failure.
 */
async function insertMetric(admin: SupabaseClient, row: MetricRow): Promise<string | null> {
  try {
    const { data, error } = await admin
      .from("ai_call_metrics")
      .insert(row)
      .select("id")
      .maybeSingle();
    if (error) {
      console.error("[ai_call_metrics] insert failed", error.message);
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error("[ai_call_metrics] insert threw", e);
    return null;
  }
}

function metricFromCall(
  base: Omit<MetricRow, "success" | "error_code" | "request_id" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_creation_tokens" | "thinking_tokens" | "latency_ms" | "provider_cost_microusd">,
  result: AnthropicCallResult | AnthropicCallFailure,
): MetricRow {
  if (result.ok) {
    const u = result.response.usage;
    return {
      ...base,
      success: true,
      error_code: null,
      request_id: result.requestId,
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
      thinking_tokens: u.thinking_tokens ?? 0,
      latency_ms: result.latencyMs,
      provider_cost_microusd: null,
    };
  }
  return {
    ...base,
    success: false,
    error_code: result.errorCode,
    request_id: result.requestId,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    thinking_tokens: 0,
    latency_ms: result.latencyMs,
    provider_cost_microusd: null,
  };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export function makeHandler(deps: HandlerDeps) {
  return async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    // Body-size guard voor alles.
    let bodyRead: BodyReadResult;
    try {
      bodyRead = await readBoundedBody(req, MAX_REQUEST_BODY_BYTES);
    } catch {
      return jsonResponse({ error: "internal_error" }, 500);
    }
    if (!bodyRead.ok) {
      if (bodyRead.reason === "too_large") return jsonResponse({ error: "payload_too_large" }, 413);
      return jsonResponse({ error: "invalid_request" }, 400);
    }

    // Auth
    const authHeader = req.headers.get("authorization") ?? "";
    const bearerMatch = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
    const jwt = bearerMatch ? bearerMatch[1] : "";
    if (!jwt) return jsonResponse({ error: "missing_authorization" }, 401);

    // Parse + validate body
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8").decode(bodyRead.bytes));
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    const parsed = GenerateRequestSchema.safeParse(raw);
    if (!parsed.success) return jsonResponse({ error: "invalid_request" }, 400);
    const input = parsed.data;

    // Verify JWT
    let userClient: SupabaseClient;
    try {
      userClient = deps.makeUserClient();
    } catch (e) {
      console.error("[generate-patch] makeUserClient threw:", e);
      return jsonResponse({ error: "internal_error" }, 500);
    }

    let user: User | null = null;
    try {
      const res = await userClient.auth.getUser(jwt);
      if (res.error) {
        console.error("[generate-patch] auth.getUser returned error:", res.error.message);
      }
      user = res.error ? null : res.data?.user ?? null;
    } catch (e) {
      console.error("[generate-patch] auth.getUser threw:", e);
      return jsonResponse({ error: "internal_error" }, 500);
    }
    if (!user) return jsonResponse({ error: "invalid_user_token" }, 401);
    if (user.aud !== "authenticated" || user.role !== "authenticated") {
      return jsonResponse({ error: "invalid_user_token" }, 401);
    }
    if (typeof user.id !== "string" || user.id.length === 0) {
      return jsonResponse({ error: "invalid_user_token" }, 401);
    }
    const userId = user.id;

    // Anthropic key
    const apiKey = deps.getAnthropicApiKey();
    if (!apiKey) {
      console.error("[generate-patch] ANTHROPIC_API_KEY is missing from env");
      return jsonResponse({ error: "internal_error" }, 500);
    }

    // Load doc under USER JWT — RLS controls access. Twee losse queries
    // i.p.v. één PostgREST-embedded join zodat elke faalvorm een specifieke
    // log krijgt en fk-resolutie geen bron van verwarring is.
    let docRow: { doc: unknown; project_id: string; organization_id: string };
    try {
      const { data, error } = await userClient
        .from("project_documents")
        .select("doc, project_id")
        .eq("id", input.project_document_id)
        .maybeSingle();
      if (error) {
        console.error(
          "[generate-patch] project_documents load failed:",
          error.message,
          "code=",
          (error as { code?: string }).code,
        );
        return jsonResponse({ error: "internal_error" }, 500);
      }
      if (!data) {
        console.error(
          "[generate-patch] project_documents not visible under RLS for id=",
          input.project_document_id,
          "user=",
          userId,
        );
        return jsonResponse({ error: "not_found" }, 404);
      }
      const partial = data as { doc: unknown; project_id: string };

      const orgRes = await userClient
        .from("projects")
        .select("organization_id")
        .eq("id", partial.project_id)
        .maybeSingle();
      if (orgRes.error) {
        console.error(
          "[generate-patch] projects load failed:",
          orgRes.error.message,
          "code=",
          (orgRes.error as { code?: string }).code,
        );
        return jsonResponse({ error: "internal_error" }, 500);
      }
      if (!orgRes.data) {
        console.error(
          "[generate-patch] projects row not visible under RLS for project_id=",
          partial.project_id,
        );
        return jsonResponse({ error: "internal_error" }, 500);
      }
      docRow = {
        doc: partial.doc,
        project_id: partial.project_id,
        organization_id: (orgRes.data as { organization_id: string }).organization_id,
      };
    } catch (e) {
      console.error("[generate-patch] doc-load threw:", e);
      return jsonResponse({ error: "internal_error" }, 500);
    }

    // Admin client voor metrics-writes
    let admin: SupabaseClient;
    try {
      admin = deps.makeAdmin();
    } catch (e) {
      console.error("[generate-patch] makeAdmin threw:", e);
      return jsonResponse({ error: "internal_error" }, 500);
    }

    // -------------------------------------------------------------------------
    // Sonnet router-call
    // -------------------------------------------------------------------------
    const systemPrompt = buildSystemPrompt(docRow.doc, input.selected_node_id);

    const orchestratorModel = deps.getOrchestratorModel();
    const specialistModel = deps.getSpecialistModel();
    const betaHeaders = deps.getBetaHeaders() ?? undefined;

    const routerResult = await deps.callAnthropic({
      apiKey,
      model: orchestratorModel,
      system: systemPrompt,
      systemCacheControl: true,
      userText: input.prompt,
      tools: ROUTER_TOOLS,
      effort: "high",
      betaHeaders,
    });

    const routerMetric = metricFromCall(
      {
        user_id: userId,
        organization_id: docRow.organization_id,
        provider: "anthropic",
        model: orchestratorModel,
        kind: "router",
        parent_call_id: null,
        route_reason: null,
        pricing_version: PRICING_VERSION,
      },
      routerResult,
    );
    const routerMetricId = await insertMetric(admin, routerMetric);

    if (!routerResult.ok) {
      return jsonResponse({ error: mapAnthropicError(routerResult) }, routerResult.status === 429 ? 429 : 502);
    }

    // Verzamel tool-uses + tekst
    const routerToolUses = extractToolUses(routerResult.response.content);
    const routerText = extractAssistantText(routerResult.response.content);

    // Zoek eventuele delegate-call
    let delegate: { enriched_prompt: string; rationale: string } | null = null;
    const directPatches: PatchOp[] = [];
    for (const tu of routerToolUses) {
      const conv = toolCallToPatch(tu.name, tu.input);
      if (conv.kind === "delegate") {
        delegate = { enriched_prompt: conv.enriched_prompt, rationale: conv.rationale };
        break;
      }
      if (conv.kind === "patch") directPatches.push(conv.op);
    }

    // Als er GEEN delegate is: return de sonnet-uitkomst rechtstreeks.
    if (!delegate) {
      return jsonResponse(
        {
          assistantMessage: routerText || defaultAckIfEmpty(directPatches.length),
          patches: directPatches,
        },
        200,
      );
    }

    // -------------------------------------------------------------------------
    // Opus specialist-call (na delegate)
    // -------------------------------------------------------------------------
    const specialistResult = await deps.callAnthropic({
      apiKey,
      model: specialistModel,
      system: systemPrompt,
      systemCacheControl: true,
      userText: delegate.enriched_prompt,
      tools: SPECIALIST_TOOLS,
      // "xhigh" wordt gebruikt voor de delegate-pad omdat de router expliciet
      // heeft geoordeeld dat dit een zwaardere-quality-taak is.
      effort: "xhigh",
      betaHeaders,
    });

    // Update de router-metric met de route_reason (nu we hem weten). We doen
    // dit als aparte insert-fase — de tabel blokkeert updates (immutable).
    // Alternatief: routeReason meteen bij de router-metric-insert zetten door
    // de call-order om te draaien. Voor v1 accepteren we dat route_reason
    // alleen op de specialist-rij staat.
    const specialistMetric = metricFromCall(
      {
        user_id: userId,
        organization_id: docRow.organization_id,
        provider: "anthropic",
        model: specialistModel,
        kind: "specialist",
        parent_call_id: routerMetricId,
        route_reason: delegate.rationale.slice(0, 500),
        pricing_version: PRICING_VERSION,
      },
      specialistResult,
    );
    await insertMetric(admin, specialistMetric);

    if (!specialistResult.ok) {
      return jsonResponse({ error: mapAnthropicError(specialistResult) }, specialistResult.status === 429 ? 429 : 502);
    }

    const specialistToolUses = extractToolUses(specialistResult.response.content);
    const specialistText = extractAssistantText(specialistResult.response.content);

    const specialistPatches: PatchOp[] = [];
    for (const tu of specialistToolUses) {
      const conv = toolCallToPatch(tu.name, tu.input);
      // Opus mag NIET her-delegateren; als het toch delegate_to_opus emit't,
      // negeren we dat en behandelen we het als "geen patches".
      if (conv.kind === "patch") specialistPatches.push(conv.op);
    }

    return jsonResponse(
      {
        assistantMessage: specialistText || routerText || defaultAckIfEmpty(specialistPatches.length),
        patches: specialistPatches,
      },
      200,
    );
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function mapAnthropicError(f: AnthropicCallFailure): string {
  if (f.status === 429) return "rate_limited";
  if (f.status >= 500 && f.status < 600) return "upstream_unavailable";
  if (f.status === 401) return "internal_error"; // upstream-auth-issue = ons config-probleem
  if (f.status === 400) return "invalid_request_upstream";
  return "upstream_error";
}

function defaultAckIfEmpty(patchCount: number): string {
  if (patchCount === 0) return "Ik heb nog geen wijziging kunnen bedenken voor deze vraag.";
  if (patchCount === 1) return "Wijziging doorgevoerd.";
  return `${patchCount} wijzigingen doorgevoerd.`;
}

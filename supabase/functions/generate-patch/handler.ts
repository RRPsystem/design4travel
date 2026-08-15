import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  CORS_HEADERS,
  type ClientStreamEvent,
  type ClientStreamTerminal,
  GenerateRequestSchema,
  jsonResponse,
  MAX_REQUEST_BODY_BYTES,
  type PatchOp,
  ROUTER_TOOLS,
  SPECIALIST_TOOLS,
  summarizeToolCall,
  toolCallToPatch,
} from "./schema.ts";
import { buildSystemPrompt } from "./prompts.ts";
import {
  type AnthropicCallFailure,
  type AnthropicMessageInput,
  type AnthropicStreamEvent,
  type AnthropicStreamStart,
  type AnthropicUsage,
  callAnthropicStream,
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
  /**
   * User-client MET Authorization-header uit de JWT zodat .from().select()
   * onder de user's RLS-context loopt.
   */
  makeUserClient: (jwt: string) => SupabaseClient;
  makeAdmin: () => SupabaseClient;
  getAnthropicApiKey: () => string | null;
  getOrchestratorModel: () => string;
  getSpecialistModel: () => string;
  getBetaHeaders: () => string | null;
  now: () => number;
  callAnthropicStream: typeof callAnthropicStream;
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
// Metrics (identiek aan pre-streaming pad — kind + parent_call_id-koppeling)
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

function metricFromStream(
  base: Omit<
    MetricRow,
    | "success"
    | "error_code"
    | "request_id"
    | "input_tokens"
    | "output_tokens"
    | "cache_read_tokens"
    | "cache_creation_tokens"
    | "thinking_tokens"
    | "latency_ms"
    | "provider_cost_microusd"
  >,
  usage: AnthropicUsage,
  latencyMs: number,
  requestId: string | null,
  errorCode: string | null,
): MetricRow {
  return {
    ...base,
    success: errorCode === null,
    error_code: errorCode,
    request_id: requestId,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
    thinking_tokens: usage.thinking_tokens ?? 0,
    latency_ms: latencyMs,
    provider_cost_microusd: null,
  };
}

function metricFromFailure(
  base: Omit<
    MetricRow,
    | "success"
    | "error_code"
    | "request_id"
    | "input_tokens"
    | "output_tokens"
    | "cache_read_tokens"
    | "cache_creation_tokens"
    | "thinking_tokens"
    | "latency_ms"
    | "provider_cost_microusd"
  >,
  f: AnthropicCallFailure,
): MetricRow {
  return {
    ...base,
    success: false,
    error_code: f.errorCode,
    request_id: f.requestId,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    thinking_tokens: 0,
    latency_ms: f.latencyMs,
    provider_cost_microusd: null,
  };
}

// -----------------------------------------------------------------------------
// Stream-accumulator (per Anthropic-call)
// -----------------------------------------------------------------------------

interface StreamAccum {
  text: string;
  toolCalls: Array<{ index: number; name: string; input: Record<string, unknown> }>;
  usage: AnthropicUsage;
  errorMessage: string | null;
  delegate: { enriched_prompt: string; rationale: string } | null;
}

function newAccum(): StreamAccum {
  return {
    text: "",
    toolCalls: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    errorMessage: null,
    delegate: null,
  };
}

function isDelegateInput(
  input: Record<string, unknown>,
): { enriched_prompt: string; rationale: string } | null {
  const ep = input.enriched_prompt;
  const rat = input.rationale;
  if (typeof ep !== "string" || ep.length === 0 || ep.length > 8000) return null;
  if (typeof rat !== "string" || rat.length === 0 || rat.length > 500) return null;
  return { enriched_prompt: ep, rationale: rat };
}

/**
 * Consumeer een Anthropic-stream, emit client-facing events per Anthropic-
 * event, en accumuleer state voor de metric + de uiteindelijke patches.
 */
async function consumeAnthropicStream(
  events: AsyncGenerator<AnthropicStreamEvent, void, void>,
  emit: (evt: ClientStreamEvent) => void,
  detectDelegate: boolean,
): Promise<StreamAccum> {
  const acc = newAccum();
  for await (const evt of events) {
    switch (evt.kind) {
      case "text_delta":
        acc.text += evt.text;
        emit({ kind: "text_delta", text: evt.text });
        break;
      case "tool_start":
        emit({ kind: "tool_start", index: evt.index, tool: evt.name });
        break;
      case "tool_input_delta":
        // Bewust NIET geëmit'd naar de client — te granulair voor de UI.
        // Client krijgt tool_complete zodra de volledige JSON binnen is.
        break;
      case "tool_complete":
        acc.toolCalls.push({ index: evt.index, name: evt.name, input: evt.input });
        emit({
          kind: "tool_complete",
          index: evt.index,
          tool: evt.name,
          summary: summarizeToolCall(evt.name, evt.input),
        });
        if (detectDelegate && evt.name === "delegate_to_opus") {
          const d = isDelegateInput(evt.input);
          if (d) acc.delegate = d;
        }
        break;
      case "usage":
        // Merge — laatste usage-event uit message_delta bevat totaal.
        acc.usage = { ...acc.usage, ...evt.usage };
        break;
      case "message_stop":
        // Einde van deze stream. Loop exit't natuurlijk.
        break;
      case "error":
        acc.errorMessage = evt.message;
        break;
    }
  }
  return acc;
}

/**
 * Filter tool-calls → PatchOp[]. Skip'd delegate_to_opus, ongeldige input,
 * en onbekende tool-namen.
 */
function toPatches(
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>,
): PatchOp[] {
  const out: PatchOp[] = [];
  for (const t of toolCalls) {
    if (t.name === "delegate_to_opus") continue;
    const conv = toolCallToPatch(t.name, t.input);
    if (conv.kind === "patch") out.push(conv.op);
  }
  return out;
}

// -----------------------------------------------------------------------------
// SSE-encoder helpers
// -----------------------------------------------------------------------------

function sseEncode(event: string, data: unknown): Uint8Array {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return new TextEncoder().encode(payload);
}

/**
 * Fallback-tekst wanneer Anthropic geen text-block emit'te. Zonder deze
 * fallback zou de UI een leeg assistant-bubbel tonen — user weet dan niet
 * of er iets is gebeurd. Bij patches: bevestig dat er wijzigingen zijn
 * doorgevoerd. Bij geen patches: expliciet melden dat er niets is gedaan
 * zodat de user niet denkt dat de prompt is genegeerd.
 */
function defaultAckIfEmpty(patchCount: number): string {
  if (patchCount === 0) return "Ik heb geen wijziging kunnen doen voor deze vraag. Kun je specifieker aangeven wat je bedoelt?";
  if (patchCount === 1) return "Wijziging doorgevoerd.";
  return `${patchCount} wijzigingen doorgevoerd.`;
}

function mapUpstreamToClientErrorCode(f: AnthropicCallFailure): string {
  if (f.status === 429) return "rate_limited";
  if (f.status >= 500 && f.status < 600) return "upstream_unavailable";
  if (f.status === 401) return "internal_error";
  if (f.status === 400) return "invalid_request_upstream";
  if (f.status === 0) return "network_error";
  return "upstream_error";
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

    // ---------- Pre-stream checks (HTTP-error op fail) ----------------------
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

    const authHeader = req.headers.get("authorization") ?? "";
    const bearerMatch = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
    const jwt = bearerMatch ? bearerMatch[1] : "";
    if (!jwt) return jsonResponse({ error: "missing_authorization" }, 401);

    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8").decode(bodyRead.bytes));
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    const parsed = GenerateRequestSchema.safeParse(raw);
    if (!parsed.success) return jsonResponse({ error: "invalid_request" }, 400);
    const input = parsed.data;

    let userClient: SupabaseClient;
    try {
      userClient = deps.makeUserClient(jwt);
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

    const apiKey = deps.getAnthropicApiKey();
    if (!apiKey) {
      console.error("[generate-patch] ANTHROPIC_API_KEY is missing from env");
      return jsonResponse({ error: "internal_error" }, 500);
    }

    // Doc-load onder USER JWT — RLS controls access. Twee losse SELECTs
    // (project_documents → projects) i.p.v. embedded join, zodat elke
    // faalvorm een specifieke log krijgt.
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

    let admin: SupabaseClient;
    try {
      admin = deps.makeAdmin();
    } catch (e) {
      console.error("[generate-patch] makeAdmin threw:", e);
      return jsonResponse({ error: "internal_error" }, 500);
    }

    // ---------- Streaming response ------------------------------------------
    const systemPrompt = buildSystemPrompt(docRow.doc, input.selected_node_id);
    const orchestratorModel = deps.getOrchestratorModel() || DEFAULT_ORCHESTRATOR;
    const specialistModel = deps.getSpecialistModel() || DEFAULT_SPECIALIST;
    const betaHeaders = deps.getBetaHeaders() ?? undefined;

    const historyMessages: AnthropicMessageInput[] = (input.history ?? []).map(
      (m) => ({ role: m.role, content: m.content }),
    );
    const routerMessages: AnthropicMessageInput[] = [
      ...historyMessages,
      { role: "user", content: input.prompt },
    ];

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emitEvent = (evt: ClientStreamEvent) => {
          try {
            controller.enqueue(sseEncode("activity", evt));
          } catch { /* controller closed */ }
        };
        const emitTerminal = (t: ClientStreamTerminal) => {
          try {
            controller.enqueue(sseEncode(t.kind, t));
          } catch { /* controller closed */ }
        };

        try {
          // ---------------- Router call (Sonnet) ----------------------------
          emitEvent({ kind: "model_change", model: orchestratorModel });

          const routerStart = await deps.callAnthropicStream({
            apiKey,
            model: orchestratorModel,
            system: systemPrompt,
            systemCacheControl: true,
            messages: routerMessages,
            tools: ROUTER_TOOLS,
            effort: "high",
            betaHeaders,
          });

          if (!routerStart.ok) {
            await insertMetric(
              admin,
              metricFromFailure(
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
                routerStart,
              ),
            );
            emitTerminal({
              kind: "error",
              code: mapUpstreamToClientErrorCode(routerStart),
              message: routerStart.errorCode,
            });
            controller.close();
            return;
          }

          const routerAcc = await consumeAnthropicStream(
            routerStart.events,
            emitEvent,
            true,
          );
          const routerLatency = deps.now() - routerStart.startedAt;

          const routerErrorCode = routerAcc.errorMessage
            ? `stream_error:${routerAcc.errorMessage.slice(0, 60)}`
            : null;
          const routerMetricId = await insertMetric(
            admin,
            metricFromStream(
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
              routerAcc.usage,
              routerLatency,
              routerStart.requestId,
              routerErrorCode,
            ),
          );

          if (routerAcc.errorMessage) {
            emitTerminal({
              kind: "error",
              code: "upstream_stream_error",
              message: routerAcc.errorMessage,
            });
            controller.close();
            return;
          }

          // ---------------- Optional specialist call (Opus) -----------------
          if (routerAcc.delegate) {
            emitEvent({
              kind: "delegate",
              from: orchestratorModel,
              to: specialistModel,
              rationale: routerAcc.delegate.rationale,
            });
            emitEvent({ kind: "model_change", model: specialistModel });

            const specialistMessages: AnthropicMessageInput[] = [
              ...historyMessages,
              { role: "user", content: routerAcc.delegate.enriched_prompt },
            ];
            const opusStart = await deps.callAnthropicStream({
              apiKey,
              model: specialistModel,
              system: systemPrompt,
              systemCacheControl: true,
              messages: specialistMessages,
              tools: SPECIALIST_TOOLS,
              effort: "xhigh",
              betaHeaders,
            });

            if (!opusStart.ok) {
              await insertMetric(
                admin,
                metricFromFailure(
                  {
                    user_id: userId,
                    organization_id: docRow.organization_id,
                    provider: "anthropic",
                    model: specialistModel,
                    kind: "specialist",
                    parent_call_id: routerMetricId,
                    route_reason: routerAcc.delegate.rationale.slice(0, 500),
                    pricing_version: PRICING_VERSION,
                  },
                  opusStart,
                ),
              );
              emitTerminal({
                kind: "error",
                code: mapUpstreamToClientErrorCode(opusStart),
                message: opusStart.errorCode,
              });
              controller.close();
              return;
            }

            const opusAcc = await consumeAnthropicStream(
              opusStart.events,
              emitEvent,
              false,
            );
            const opusLatency = deps.now() - opusStart.startedAt;
            const opusErrorCode = opusAcc.errorMessage
              ? `stream_error:${opusAcc.errorMessage.slice(0, 60)}`
              : null;
            await insertMetric(
              admin,
              metricFromStream(
                {
                  user_id: userId,
                  organization_id: docRow.organization_id,
                  provider: "anthropic",
                  model: specialistModel,
                  kind: "specialist",
                  parent_call_id: routerMetricId,
                  route_reason: routerAcc.delegate.rationale.slice(0, 500),
                  pricing_version: PRICING_VERSION,
                },
                opusAcc.usage,
                opusLatency,
                opusStart.requestId,
                opusErrorCode,
              ),
            );

            if (opusAcc.errorMessage) {
              emitTerminal({
                kind: "error",
                code: "upstream_stream_error",
                message: opusAcc.errorMessage,
              });
              controller.close();
              return;
            }

            const patches = toPatches(opusAcc.toolCalls);
            emitTerminal({
              kind: "done",
              assistantMessage:
                (opusAcc.text || routerAcc.text || "").trim() ||
                defaultAckIfEmpty(patches.length),
              patches,
            });
            controller.close();
            return;
          }

          // ---------------- No delegate: router-only ------------------------
          const patches = toPatches(routerAcc.toolCalls);
          emitTerminal({
            kind: "done",
            assistantMessage:
              (routerAcc.text || "").trim() || defaultAckIfEmpty(patches.length),
            patches,
          });
          controller.close();
        } catch (e) {
          console.error("[generate-patch] stream orchestration threw:", e);
          try {
            controller.enqueue(
              sseEncode("error", {
                kind: "error",
                code: "internal_error",
                message: String(e).slice(0, 200),
              }),
            );
          } catch { /* controller may be closed */ }
          try { controller.close(); } catch { /* ignore */ }
        }
      },
      cancel() {
        // Client heeft de connectie afgebroken. Metrics zijn al gelogd voor
        // wat de router-fase heeft opgeleverd; verdere calls stoppen we niet
        // actief (Anthropic-request loopt door tot voltooiing). Voor v1
        // accepteren we die overhead — een AbortController-chain toevoegen
        // is aparte scope.
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  };
}

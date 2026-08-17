/**
 * generate-studio4-component — iteratie 4c.1
 *
 * AI-generatie van een Studio4-component-pakket (manifest.json + <Name>.tsx)
 * op basis van een reference-image in de `design-references` bucket.
 *
 * Flow:
 *   1. Auth-verify (user-JWT of dev-bypass, zelfde patroon als sandbox-build-trigger)
 *   2. Signed download URL voor reference-image
 *   3. Call Claude Sonnet 5 met vision + tool `emit_studio4_component_package`
 *   4. Runt inline validator (POLICY_V1_0 kopie — Deno kan workspace-dep niet importeren)
 *   5. Bij validator-errors: repair-turn met Opus 5 (max 3 iteraties)
 *   6. Return files + validation-log + iteration-count
 *
 * Volgende iteratie (4c.2): pipeline-integratie — auto build-archive + sandbox-run + iframe.
 */

import { POLICY_V1_0 } from './policy.ts';
import { validatePackage, type ValidationResult } from './validator.ts';
import {
  SYSTEM_PROMPT,
  buildInitialUserMessage,
  buildRepairUserMessage,
  buildRevisionUserMessage,
  EMIT_TOOL,
} from './prompts.ts';
import { callClaudeVision, type EmittedPackage } from './anthropic.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_ITERATIONS = 3;

// -----------------------------------------------------------------------------
// Auth helpers (kopie van sandbox-build-trigger — Deno kan geen workspace-code delen)
// -----------------------------------------------------------------------------

interface AuthResult {
  kind: 'user' | 'dev_bypass';
  userId?: string;
  email?: string;
}

async function verifyAuth(
  req: Request,
  supabaseUrl: string,
  serviceKey: string,
): Promise<AuthResult | { error: string; status: number }> {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return { error: 'missing_bearer_token', status: 401 };
  }
  const token = authHeader.slice(7).trim();
  if (!token) return { error: 'empty_bearer_token', status: 401 };
  if (token === serviceKey) return { kind: 'dev_bypass' };
  if (token.startsWith('sb_publishable_') || token.startsWith('sb_anon_')) {
    return { error: 'anon_key_not_accepted_use_user_jwt_or_service_role', status: 401 };
  }
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return { error: `auth_verify_${r.status}`, status: 401 };
  const user = (await r.json()) as { id?: string; email?: string };
  if (!user.id) return { error: 'auth_no_user_id', status: 401 };
  return { kind: 'user', userId: user.id, email: user.email };
}

async function signedDownloadUrl(
  supabaseUrl: string, serviceKey: string, bucket: string, path: string, expiresIn: number,
): Promise<string> {
  const r = await fetch(`${supabaseUrl}/storage/v1/object/sign/${bucket}/${path}`, {
    method: 'POST',
    headers: { apikey: serviceKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  });
  if (!r.ok) throw new Error(`sign_${r.status}: ${await r.text()}`);
  const j = await r.json() as { signedURL?: string; signedUrl?: string };
  const suffix = j.signedURL || j.signedUrl;
  if (!suffix) throw new Error('no_signedUrl_in_response');
  return `${supabaseUrl}/storage/v1${suffix}`;
}

// -----------------------------------------------------------------------------
// Image-token resolver
// -----------------------------------------------------------------------------

const IMAGE_TOKEN_REGEX = /\{\{image:([^|}]+)\|([^}]+)\}\}/g;

interface TokenResolveResult {
  componentTsx: string;
  tokensFound: number;
  tokensResolved: number;
  sources: Record<string, number>; // 'unsplash'|'pexels'|'picsum' → count
  errors: string[];
}

/**
 * Vervang `{{image:role|query}}`-tokens door concrete image-URLs via de
 * media-search Edge Function (Unsplash → Pexels → picsum-fallback).
 * Dedup op query zodat we niet 5x dezelfde search doen voor dezelfde term.
 * Fail-soft: als een token niet resolveerbaar is, blijft de token in de src
 * staan (broken image is beter dan complete generation-fail).
 */
async function resolveImageTokens(
  componentTsx: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<TokenResolveResult> {
  const matches = [...componentTsx.matchAll(IMAGE_TOKEN_REGEX)];
  const uniqueQueries = new Set<string>();
  for (const m of matches) uniqueQueries.add(m[2]!.trim());

  const urlByQuery = new Map<string, string>();
  const sources: Record<string, number> = {};
  const errors: string[] = [];

  await Promise.all(
    [...uniqueQueries].map(async (q) => {
      try {
        const r = await fetch(`${supabaseUrl}/functions/v1/media-search`, {
          method: 'POST',
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: q, orientation: 'landscape' }),
        });
        const j = (await r.json()) as { ok?: boolean; url?: string; source?: string; error?: string };
        if (!r.ok || !j.ok || !j.url) {
          errors.push(`"${q}": ${j.error ?? `http_${r.status}`}`);
          return;
        }
        urlByQuery.set(q, j.url);
        const src = j.source ?? 'unknown';
        sources[src] = (sources[src] ?? 0) + 1;
      } catch (e) {
        errors.push(`"${q}": ${(e as Error).message}`);
      }
    }),
  );

  let resolved = 0;
  const out = componentTsx.replace(IMAGE_TOKEN_REGEX, (full, _role: string, query: string) => {
    const url = urlByQuery.get(query.trim());
    if (!url) return full; // token blijft staan
    resolved++;
    return url;
  });

  return {
    componentTsx: out,
    tokensFound: matches.length,
    tokensResolved: resolved,
    sources,
    errors,
  };
}

// -----------------------------------------------------------------------------
// Content-source helper (internal fetch met service-role)
// -----------------------------------------------------------------------------

interface TravelContentLite {
  title?: string;
  intro?: string;
  days?: number;
  countries?: string[];
  destinations?: Array<{ name?: string; country?: string }>;
  hero_image_hint?: string;
  meta?: { source_kind?: string; hash?: string };
}

async function fetchContentSourceById(
  supabaseUrl: string,
  serviceKey: string,
  ownerUserId: string,
  contentSourceId: string,
): Promise<TravelContentLite | null> {
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/content_sources?id=eq.${contentSourceId}&owner_user_id=eq.${ownerUserId}&select=content`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    if (!r.ok) return null;
    const rows = await r.json() as Array<{ content?: TravelContentLite }>;
    return rows[0]?.content ?? null;
  } catch {
    return null;
  }
}

function buildFixtureHintFromContent(c: TravelContentLite): string {
  const parts: string[] = [];
  if (c.title) parts.push(`Titel: ${c.title}`);
  if (c.days) parts.push(`Duur: ${c.days} dagen`);
  if (c.countries?.length) parts.push(`Landen: ${c.countries.join(', ')}`);
  if (c.destinations?.length) {
    const names = c.destinations
      .map((d) => d.name)
      .filter(Boolean)
      .slice(0, 8)
      .join(', ');
    if (names) parts.push(`Bestemmingen: ${names}`);
  }
  if (c.hero_image_hint) parts.push(`Hero-thema: ${c.hero_image_hint}`);
  if (c.intro) parts.push(`Sfeer: ${c.intro.slice(0, 240)}`);
  return parts.join(' — ');
}

// -----------------------------------------------------------------------------
// Metrics logging (fail-open)
// -----------------------------------------------------------------------------

async function logMetric(
  supabaseUrl: string, serviceKey: string, row: Record<string, unknown>,
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/ai_call_metrics`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  }).catch(() => { /* fail-open */ });
}

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------

interface GenerationLog {
  iteration: number;
  model: string;
  latency_ms: number;
  tokens_in?: number;
  tokens_out?: number;
  validation: ValidationResult;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!anthropicKey || !supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'missing_env',
        details: {
          anthropic_api_key: Boolean(anthropicKey),
          supabase_url: Boolean(supabaseUrl),
          supabase_service_role_key: Boolean(serviceKey),
        },
      }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const auth = await verifyAuth(req, supabaseUrl, serviceKey);
  if ('error' in auth) {
    return new Response(
      JSON.stringify({ ok: false, error: auth.error }),
      { status: auth.status, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  let body: {
    reference_path?: string;
    chat_prompt?: string;
    fixture_hint?: string;
    content_source_id?: string;
    previous_package?: { manifest: Record<string, unknown>; componentTsx: string };
    previous_feedback?: {
      match_score: number;
      summary: string;
      differences: Array<{ area: string; severity: string; suggestion: string }>;
    };
  } = {};
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_json_body' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  if (!body.reference_path) {
    return new Response(
      JSON.stringify({ ok: false, error: 'reference_path_required' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const parentCallId = crypto.randomUUID();
  const t0 = Date.now();
  const generationLog: GenerationLog[] = [];
  let finalPackage: EmittedPackage | null = null;
  let finalValidation: ValidationResult | null = null;
  let error: string | null = null;

  try {
    // Signed URL voor de reference-image (Claude vision fetcht 'm zelf)
    const imageUrl = await signedDownloadUrl(
      supabaseUrl, serviceKey, 'design-references', body.reference_path, 600,
    );

    // Content-source: als opgegeven, fetch gesanitiseerd TravelContent en
    // vul fixture_hint aan met een korte samenvatting voor de AI-prompt.
    // Alleen title/days/destinations/hero_image_hint/intro — geen ruwe DB-
    // fields, geen API-keys, geen prijzen die per boeking variëren.
    let effectiveFixtureHint = body.fixture_hint ?? '';
    if (body.content_source_id && auth.kind === 'user' && auth.userId) {
      const content = await fetchContentSourceById(
        supabaseUrl, serviceKey, auth.userId, body.content_source_id,
      );
      if (content) {
        const hint = buildFixtureHintFromContent(content);
        effectiveFixtureHint = hint
          ? (effectiveFixtureHint ? `${effectiveFixtureHint}\n\nReis-context: ${hint}` : `Reis-context: ${hint}`)
          : effectiveFixtureHint;
      }
    }

    // Modus: initial (nieuwe generatie) of revision (verbetering op vorige)
    const isRevision = Boolean(body.previous_package?.manifest && body.previous_package?.componentTsx);

    // Iteratie-loop
    let lastValidation: ValidationResult | null = null;
    let lastToolUseId: string | null = null;
    for (let i = 1; i <= MAX_ITERATIONS; i++) {
      const model = i === 1 ? 'claude-sonnet-5' : 'claude-opus-5';

      const firstMessage = isRevision
        ? buildRevisionUserMessage(
            imageUrl,
            body.chat_prompt ?? '',
            body.previous_package!.manifest,
            body.previous_package!.componentTsx,
            body.previous_feedback ?? null,
          )
        : buildInitialUserMessage(imageUrl, body.chat_prompt ?? '', effectiveFixtureHint);

      const messages = i === 1
        ? [firstMessage]
        : [
            firstMessage,
            {
              role: 'assistant',
              content: [{
                type: 'tool_use',
                id: lastToolUseId!,
                name: 'emit_studio4_component_package',
                input: finalPackage ?? {},
              }],
            },
            buildRepairUserMessage(lastValidation!, lastToolUseId!),
          ];

      const tCall = Date.now();
      const callResult = await callClaudeVision({
        apiKey: anthropicKey,
        model,
        system: SYSTEM_PROMPT,
        messages,
        tools: [EMIT_TOOL],
        maxTokens: 6000,
      });
      const latency = Date.now() - tCall;

      finalPackage = callResult.emitted;
      lastToolUseId = callResult.toolUseId;
      finalValidation = validatePackage(
        {
          manifestJson: JSON.stringify(callResult.emitted.manifest),
          componentTsx: callResult.emitted.componentTsx,
        },
        POLICY_V1_0,
      );

      generationLog.push({
        iteration: i,
        model,
        latency_ms: latency,
        tokens_in: callResult.tokensIn,
        tokens_out: callResult.tokensOut,
        validation: finalValidation,
      });

      // Metric-log per iteratie
      if (auth.kind === 'user' && auth.userId) {
        await logMetric(supabaseUrl, serviceKey, {
          parent_call_id: parentCallId,
          user_id: auth.userId,
          model,
          latency_ms: latency,
          tokens_in: callResult.tokensIn,
          tokens_out: callResult.tokensOut,
          purpose: 'generate-studio4-component',
          meta: {
            iteration: i,
            validation_ok: finalValidation.ok,
            validation_errors: finalValidation.errorCount,
          },
        });
      }

      if (finalValidation.ok) break;
      lastValidation = finalValidation;
    }
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  // Na succesvolle validatie: vervang {{image:role|query}}-tokens door
  // echte URLs via media-search (Unsplash → Pexels → picsum-fallback).
  // Fail-soft: bij media-search-fouten blijven tokens staan, generation
  // wordt niet gefaald.
  let tokenResolve: TokenResolveResult | null = null;
  if (!error && finalValidation?.ok && finalPackage) {
    try {
      tokenResolve = await resolveImageTokens(
        finalPackage.componentTsx,
        supabaseUrl,
        serviceKey,
      );
      finalPackage = { ...finalPackage, componentTsx: tokenResolve.componentTsx };
    } catch (e) {
      // Log maar niet fatal
      tokenResolve = {
        componentTsx: finalPackage.componentTsx,
        tokensFound: 0,
        tokensResolved: 0,
        sources: {},
        errors: [`resolver_error: ${(e as Error).message}`],
      };
    }
  }

  return new Response(
    JSON.stringify({
      ok: !error && Boolean(finalValidation?.ok),
      parent_call_id: parentCallId,
      duration_total_ms: Date.now() - t0,
      iterations_used: generationLog.length,
      max_iterations: MAX_ITERATIONS,
      error,
      generation_log: generationLog,
      final_package: finalPackage,
      final_validation: finalValidation,
      image_tokens: tokenResolve,
      content_source_id: body.content_source_id ?? null,
    }, null, 2),
    { headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
});

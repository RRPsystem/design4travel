/**
 * resolve-content-source — server-side content-bron-resolver
 *
 * Design4-generieke content-source-flow (iteratie 1 — alleen `fixture`-kind).
 * Input:  { kind, source_id? }
 * Output: { ok, content_source_id, content, hash, version }
 *
 * Elke bron mapt naar één gevalideerd TravelContent (Zod-strict, geen extra
 * velden). Resultaat wordt geüpsert in `content_sources`-tabel met unique-
 * key (owner_user_id, kind, source_id, version) zodat repeat-resolves goedkoop
 * zijn en het ontwerp exact naar één versie kan referen.
 *
 * BEVEILIGING (zie migratie 0022 + user-instructie 2026-08-17):
 *   - API-keys / ruwe DB-fields komen NOOIT in de response — sanitisation
 *     zit in de adapter, Zod is de laatste gate.
 *   - Andere kinds dan `fixture` retourneren 501 (stub) tot hun adapter
 *     geïmplementeerd is.
 */

import { TravelContentSchema, TravelSourceKindSchema } from './schema.ts';
import { resolveFixture, type FixtureLoader } from './fixture-adapter.ts';
import { EMBEDDED_FIXTURES } from './fixtures-embedded.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// -----------------------------------------------------------------------------
// Auth (identiek patroon aan andere Design4-Edge-Functions)
// -----------------------------------------------------------------------------

interface AuthResult {
  kind: 'user' | 'service_role';
  userId?: string;
}

async function verifyAuth(
  req: Request, supabaseUrl: string, serviceKey: string,
): Promise<AuthResult | { error: string; status: number }> {
  const h = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!h || !h.toLowerCase().startsWith('bearer ')) return { error: 'missing_bearer_token', status: 401 };
  const token = h.slice(7).trim();
  if (!token) return { error: 'empty_bearer_token', status: 401 };
  if (token === serviceKey) return { kind: 'service_role' };
  if (token.startsWith('sb_publishable_') || token.startsWith('sb_anon_')) {
    return { error: 'anon_key_not_accepted', status: 401 };
  }
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return { error: `auth_verify_${r.status}`, status: 401 };
  const u = await r.json() as { id?: string };
  if (!u.id) return { error: 'auth_no_user_id', status: 401 };
  return { kind: 'user', userId: u.id };
}

// -----------------------------------------------------------------------------
// Fixture loader — leest embedded fixture-JSON uit ./fixtures/
// -----------------------------------------------------------------------------

const fixtureLoader: FixtureLoader = (slug: string) => {
  // Slug-sanitize: alleen a-z 0-9 -; voorkomt injection in dict-lookup.
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) return Promise.resolve(null);
  // Fixtures zijn embedded in de bundle (Supabase Edge Functions hebben geen
  // runtime-fs-access voor relative paths). Update via
  // `node scripts/embed-content-fixtures.mjs`.
  return Promise.resolve(EMBEDDED_FIXTURES[slug] ?? null);
};

// -----------------------------------------------------------------------------
// Studio4-content resolver (inline — Deno kan geen workspace-package importeren)
// -----------------------------------------------------------------------------

const STUDIO4_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

async function resolveStudio4Content(
  sourceId: string,
  gatewayUrl: string,
  userJwt: string,
): Promise<{ content: unknown; hash: string; version: string }> {
  if (!STUDIO4_ID_REGEX.test(sourceId)) {
    throw new Error(`studio4_invalid_source_id: "${sourceId}"`);
  }
  const url = `${gatewayUrl.replace(/\/+$/, '')}/travels/${encodeURIComponent(sourceId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let r: Response;
  try {
    r = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${userJwt}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (r.status === 401 || r.status === 403) throw new Error(`studio4_gateway_auth_${r.status}`);
  if (r.status === 404) throw new Error(`studio4_travel_not_found:${sourceId}`);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`studio4_gateway_http_${r.status}: ${t.slice(0, 200)}`);
  }
  const body = await r.json() as { ok?: boolean; content?: unknown; error?: string };
  if (!body.ok || !body.content) {
    throw new Error(`studio4_gateway_error: ${body.error ?? 'unknown'}`);
  }
  // Strict Zod-parse — gateway MOET conform TravelContent v1
  const check = TravelContentSchema.safeParse(body.content);
  if (!check.success) {
    throw new Error(
      `studio4_gateway_schema_violation: ${check.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).slice(0, 3).join(';')}`,
    );
  }
  const c = check.data as { meta?: { hash?: string; version?: string } };
  return {
    content: check.data,
    hash: c.meta?.hash ?? '',
    version: c.meta?.version ?? '1.0',
  };
}

// -----------------------------------------------------------------------------
// Persistence — upsert in content_sources
// -----------------------------------------------------------------------------

async function upsertContentSource(
  supabaseUrl: string,
  serviceKey: string,
  ownerUserId: string,
  row: {
    kind: string;
    source_id: string | null;
    version: string | null;
    hash: string;
    content: unknown;
  },
): Promise<{ id: string } | { error: string }> {
  // ON CONFLICT (owner_user_id, kind, source_id, version) DO UPDATE via
  // PostgREST upsert. `?on_conflict=...` is verplicht — anders weet PostgREST
  // niet op welke kolommen te resolveren en faalt op de UNIQUE-constraint.
  const conflictCols = 'owner_user_id,kind,source_id,version';
  const r = await fetch(`${supabaseUrl}/rest/v1/content_sources?on_conflict=${conflictCols}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation,resolution=merge-duplicates',
    },
    body: JSON.stringify({
      owner_user_id: ownerUserId,
      kind: row.kind,
      source_id: row.source_id,
      version: row.version,
      hash: row.hash,
      content: row.content,
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    return { error: `upsert_${r.status}: ${text.slice(0, 300)}` };
  }
  const rows = await r.json() as Array<{ id?: string }>;
  const id = rows[0]?.id;
  if (!id) return { error: 'upsert_no_id_returned' };
  return { id };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ ok: false, error: 'missing_env' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const auth = await verifyAuth(req, supabaseUrl, serviceKey);
  if ('error' in auth) {
    return new Response(JSON.stringify({ ok: false, error: auth.error }), {
      status: auth.status, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  // Service-role internal call MUST supply owner_user_id in body (want er is
  // dan geen echte user achter het request).
  let body: { kind?: string; source_id?: string; owner_user_id?: string } = {};
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_json_body' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const kindParse = TravelSourceKindSchema.safeParse(body.kind);
  if (!kindParse.success) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_kind' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  const kind = kindParse.data;

  const ownerUserId = auth.kind === 'user' ? auth.userId! : body.owner_user_id;
  if (!ownerUserId) {
    return new Response(JSON.stringify({ ok: false, error: 'owner_user_id_required_for_service_role' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // Resolve dispatch per kind. Alleen fixture + studio4_content geïmplementeerd;
  // travel_compositor + manual komen in vervolgiteratie.
  let resolved: { content: unknown; hash: string; version: string };
  try {
    if (kind === 'fixture') {
      resolved = await resolveFixture(body.source_id ?? '', fixtureLoader);
    } else if (kind === 'studio4_content') {
      // Gateway-URL vereist (fail-safe: geen fallback, geen implicit bypass).
      const gatewayUrl = Deno.env.get('STUDIO4_GATEWAY_URL');
      if (!gatewayUrl) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: 'studio4_gateway_not_configured',
            details: 'STUDIO4_GATEWAY_URL secret ontbreekt in Supabase — vraag beheerder om Studio4-integratie aan te zetten.',
          }),
          { status: 503, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
      }

      // Forward user-JWT naar gateway. Service-role calls kunnen geen
      // studio4_content resolven — dit vereist een echte user-context zodat
      // de gateway kan rol-checken en org-scopen.
      if (auth.kind !== 'user') {
        return new Response(
          JSON.stringify({ ok: false, error: 'studio4_requires_user_auth' }),
          { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
      }
      const forwardedJwt = (req.headers.get('authorization') || req.headers.get('Authorization') || '').slice(7).trim();
      if (!forwardedJwt) {
        return new Response(
          JSON.stringify({ ok: false, error: 'studio4_missing_forwarded_jwt' }),
          { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
      }

      resolved = await resolveStudio4Content(body.source_id ?? '', gatewayUrl, forwardedJwt);
    } else {
      return new Response(
        JSON.stringify({
          ok: false,
          error: `kind_not_implemented:${kind}`,
          details: 'travel_compositor + manual komen in vervolgiteratie.',
        }),
        { status: 501, headers: { ...CORS, 'Content-Type': 'application/json' } },
      );
    }
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: `resolve_failed: ${(e as Error).message}` }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  // Defense-in-depth: schema check ná adapter (adapter doet dat ook al maar
  // veiligheidsnet als canonical schema drift optreedt).
  const finalCheck = TravelContentSchema.safeParse(resolved.content);
  if (!finalCheck.success) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'content_final_check_failed',
        issues: finalCheck.error.issues,
      }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  // Upsert in content_sources
  const upsert = await upsertContentSource(supabaseUrl, serviceKey, ownerUserId, {
    kind,
    source_id: body.source_id ?? null,
    version: resolved.version,
    hash: resolved.hash,
    content: finalCheck.data,
  });
  if ('error' in upsert) {
    return new Response(
      JSON.stringify({ ok: false, error: upsert.error }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      content_source_id: upsert.id,
      content: finalCheck.data,
      hash: resolved.hash,
      version: resolved.version,
    }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
});

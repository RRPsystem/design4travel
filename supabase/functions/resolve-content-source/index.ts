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

const fixtureLoader: FixtureLoader = async (slug: string) => {
  // Slug-sanitize: alleen a-z 0-9 -; voorkomt path-traversal.
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(slug)) return null;
  const filename = `fixture-${slug}.json`;
  try {
    return await Deno.readTextFile(new URL(`./fixtures/${filename}`, import.meta.url));
  } catch {
    return null;
  }
};

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
  // ON CONFLICT (owner_user_id, kind, source_id, version) DO UPDATE
  // via PostgREST resolution=merge-duplicates.
  const r = await fetch(`${supabaseUrl}/rest/v1/content_sources`, {
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

  // Alleen fixture geïmplementeerd — andere kinds → 501
  if (kind !== 'fixture') {
    return new Response(
      JSON.stringify({
        ok: false,
        error: `kind_not_implemented:${kind}`,
        details: 'TravelCompositor / Studio4-content / manual komen in vervolgiteratie. Nu alleen fixture-kind.',
      }),
      { status: 501, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  // Resolve via fixture-adapter
  let resolved;
  try {
    resolved = await resolveFixture(body.source_id ?? '', fixtureLoader);
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

/**
 * media-search — Design4-eigen mediazoeker (Unsplash + Pexels)
 *
 * Design4-backend gebruikt deze functie tijdens generate-studio4-component
 * om `{{image:role|query}}`-tokens die Claude uitspuwt te vervangen door
 * echte, bestaande image-URLs. Server-side keys — worden nooit naar
 * frontend of sandbox verstuurd.
 *
 * Flow:
 *   1. Auth (user JWT via Design4-Supabase, of service-role voor internal
 *      calls vanuit generate-studio4-component)
 *   2. Probeer Unsplash search (best voor thematische stock photography)
 *   3. Fallback Pexels als Unsplash 0 results of error
 *   4. Fallback picsum.photos met seed als beide falen (garandeert werkende URL)
 *
 * Input:  { query: string, per_page?: number, orientation?: 'landscape'|'portrait'|'squarish' }
 * Output: { ok: true, url, thumb, alt, source, photographer }  |  { ok: false, error }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface AuthResult {
  kind: 'user' | 'service_role';
  userId?: string;
}

async function verifyAuth(
  req: Request,
  supabaseUrl: string,
  serviceKey: string,
): Promise<AuthResult | { error: string; status: number }> {
  const h = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!h || !h.toLowerCase().startsWith('bearer ')) {
    return { error: 'missing_bearer_token', status: 401 };
  }
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
  const u = (await r.json()) as { id?: string };
  if (!u.id) return { error: 'auth_no_user_id', status: 401 };
  return { kind: 'user', userId: u.id };
}

interface MediaResult {
  url: string;
  thumb: string;
  alt: string;
  source: 'unsplash' | 'pexels' | 'picsum';
  photographer?: { name: string; url?: string };
}

async function searchUnsplash(query: string, orientation: string): Promise<MediaResult | null> {
  const key = Deno.env.get('UNSPLASH_ACCESS_KEY');
  if (!key) return null;
  try {
    const r = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=${orientation}`,
      { headers: { Authorization: `Client-ID ${key}` } },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as {
      results?: Array<{
        urls?: { regular?: string; small?: string };
        alt_description?: string | null;
        description?: string | null;
        user?: { name?: string; links?: { html?: string } };
      }>;
    };
    const first = j.results?.[0];
    if (!first?.urls?.regular) return null;
    return {
      url: first.urls.regular,
      thumb: first.urls.small ?? first.urls.regular,
      alt: first.alt_description ?? first.description ?? query,
      source: 'unsplash',
      photographer: first.user?.name
        ? { name: first.user.name, url: first.user.links?.html }
        : undefined,
    };
  } catch {
    return null;
  }
}

async function searchPexels(query: string, orientation: string): Promise<MediaResult | null> {
  const key = Deno.env.get('PEXELS_API_KEY');
  if (!key) return null;
  try {
    const r = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=${orientation}`,
      { headers: { Authorization: key } },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as {
      photos?: Array<{
        src?: { large2x?: string; large?: string; medium?: string };
        alt?: string;
        photographer?: string;
        photographer_url?: string;
      }>;
    };
    const first = j.photos?.[0];
    if (!first?.src?.large2x && !first?.src?.large) return null;
    return {
      url: first.src.large2x ?? first.src.large ?? first.src.medium ?? '',
      thumb: first.src.medium ?? first.src.large ?? '',
      alt: first.alt ?? query,
      source: 'pexels',
      photographer: first.photographer
        ? { name: first.photographer, url: first.photographer_url }
        : undefined,
    };
  } catch {
    return null;
  }
}

function picsumFallback(query: string): MediaResult {
  const seed = encodeURIComponent(query.slice(0, 60));
  const url = `https://picsum.photos/seed/${seed}/1920/1080`;
  return { url, thumb: url, alt: query, source: 'picsum' };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ ok: false, error: 'missing_env' }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const auth = await verifyAuth(req, supabaseUrl, serviceKey);
  if ('error' in auth) {
    return new Response(JSON.stringify({ ok: false, error: auth.error }), {
      status: auth.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let body: { query?: string; orientation?: string } = {};
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_json_body' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  const query = (body.query ?? '').trim();
  if (!query) {
    return new Response(JSON.stringify({ ok: false, error: 'query_required' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  const orientation = ['landscape', 'portrait', 'squarish'].includes(body.orientation ?? '')
    ? (body.orientation as string)
    : 'landscape';

  // Volgorde: Unsplash → Pexels → picsum-fallback
  const result =
    (await searchUnsplash(query, orientation)) ??
    (await searchPexels(query, orientation)) ??
    picsumFallback(query);

  return new Response(JSON.stringify({ ok: true, ...result }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});

import { validatePackage } from '@design4/studio4-sdk/validator';

/**
 * validate-package — canonical AST-validator als HTTP-service.
 *
 * Waarom deze bestaat: canonical validator uit `@design4/studio4-sdk` gebruikt
 * @typescript-eslint/parser (echte AST-scan, geen false-positives) — te zwaar
 * voor Deno Edge Function cold-starts. Deze Netlify Function draait in Node op
 * previewdesign4.netlify.app en is de EINDGATE die sandbox-build-trigger
 * verplicht aanroept vóór build/expose/PR. Deno-side check in
 * generate-studio4-component blijft snelle iteratie-loop-hulp, maar geeft
 * geen bouw-toestemming.
 *
 * Security:
 *   - Bearer-auth met CANONICAL_VALIDATOR_SECRET env-var (server-to-server).
 *   - Zonder secret geconfigureerd → 500 (fail-safe, geen bypass).
 *   - Body-cap 512 KB om onbedoelde grote payloads / DoS te dempen.
 */

const MAX_BODY_BYTES = 512 * 1024;

export default async (req: Request): Promise<Response> => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const secret = process.env.CANONICAL_VALIDATOR_SECRET;
  if (!secret) {
    // Fail-safe: zonder secret is er geen shared trust; NIET impliciet toestaan.
    return new Response(
      JSON.stringify({ ok: false, error: 'server_secret_not_configured' }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const authHeader = req.headers.get('authorization') ?? '';
  if (authHeader !== `Bearer ${secret}`) {
    return new Response(
      JSON.stringify({ ok: false, error: 'unauthorized' }),
      { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  // Body-cap via content-length hint + hard trim
  const cl = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
    return new Response(
      JSON.stringify({ ok: false, error: 'body_too_large' }),
      { status: 413, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  let body: { manifestJson?: string; componentTsx?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ ok: false, error: 'invalid_json_body' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  if (typeof body.manifestJson !== 'string' || typeof body.componentTsx !== 'string') {
    return new Response(
      JSON.stringify({ ok: false, error: 'missing_manifestJson_or_componentTsx' }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const totalBytes = body.manifestJson.length + body.componentTsx.length;
  if (totalBytes > MAX_BODY_BYTES) {
    return new Response(
      JSON.stringify({ ok: false, error: 'payload_too_large' }),
      { status: 413, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  const result = validatePackage({
    manifestJson: body.manifestJson,
    componentTsx: body.componentTsx,
  });

  return new Response(
    JSON.stringify({
      ok: result.ok,
      issues: result.issues,
      errorCount: result.errorCount,
      warningCount: result.warningCount,
    }),
    { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } },
  );
};

export const config = { path: '/api/validate-package' };

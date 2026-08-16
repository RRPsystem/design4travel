/**
 * sandbox-callback — iteratie 1 (stub)
 *
 * Doel iteratie 1: deploy-pipeline bewijzen. Accepteert POST met een payload
 * en logt hem. GEEN storage-writes, geen job-state-updates.
 *
 * Iteratie 2:
 * - Verifieer signed callback-token (voorkomt dat willekeurige clients status
 *   spoofen namens de sandbox)
 * - Update `sandbox_jobs.status` met `build_started` / `build_done` / `error`
 * - Als payload screenshots-referenties bevat: verifieer aanwezigheid in
 *   `sandbox-screenshots` bucket
 * - Realtime-event zodat Design4-UI status kan volgen
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    // body optional voor de stub
  }

  const payload = {
    ok: true,
    stub: true,
    received: body,
    note: 'Iteratie 1 stub. Real callback-verwerking komt in iteratie 2.',
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});

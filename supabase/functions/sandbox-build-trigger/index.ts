/**
 * sandbox-build-trigger — iteratie 2d
 *
 * Reduceert cold-start footprint zodat de Edge Function niet meer op
 * WORKER_RESOURCE_LIMIT crasht:
 *   - `e2b` via esm.sh (pre-bundled ESM, kleiner dan npm:-shim).
 *   - GEEN @supabase/supabase-js — Storage-signing via directe fetch().
 *   - Sandbox uploadt zelf desktop.png + mobile.png via signed upload-URLs.
 *     Geen PNG-bytes meer door de Edge Function worker.
 *
 * Twee phases (elk < 150s Supabase IDLE_TIMEOUT):
 *   phase "prepare" — apt-libs + Playwright + Chromium in /home/user/tools/
 *   phase "build"   — Sandbox.connect + download archive + vite build +
 *                      screenshots + sandbox curl PUT naar Storage +
 *                      Edge Function return signed download URLs
 */

import { Sandbox } from 'https://esm.sh/e2b@2.39.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const CHROMIUM_APT_LIBS = [
  'libnss3', 'libnspr4', 'libatk1.0-0', 'libatk-bridge2.0-0', 'libcups2',
  'libdrm2', 'libxkbcommon0', 'libxcomposite1', 'libxdamage1', 'libxfixes3',
  'libxrandr2', 'libgbm1', 'libpango-1.0-0', 'libcairo2', 'libasound2',
].join(' ');

// -----------------------------------------------------------------------------
// Screenshot script (CommonJS, met veel logging)
// -----------------------------------------------------------------------------

const SCREENSHOT_SCRIPT = `
console.log('[screenshot] starting, NODE_PATH=' + (process.env.NODE_PATH || ''));

let chromium;
try {
  chromium = require('playwright').chromium;
  console.log('[screenshot] playwright loaded, version=' + require('playwright/package.json').version);
} catch (e) {
  console.error('[screenshot] FAILED to require playwright: ' + e.message);
  process.exit(2);
}

const url = process.env.SCREENSHOT_URL || 'http://127.0.0.1:8080';
const outDir = process.env.OUT_DIR || '/home/user';
console.log('[screenshot] url=' + url + ' outDir=' + outDir);

async function snap(browser, name, viewport, isMobile) {
  console.log('[screenshot] context ' + name + ' viewport=' + JSON.stringify(viewport));
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: isMobile ? 2 : 1,
    isMobile: !!isMobile,
    hasTouch: !!isMobile,
    javaScriptEnabled: true,
    serviceWorkers: 'block',
  });
  console.log('[screenshot] newContext ' + name + ' OK, calling newPage');
  const page = await ctx.newPage();
  console.log('[screenshot] newPage ' + name + ' OK, calling goto');
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
    console.log('[screenshot] commit ' + name);
  } catch (e) {
    console.error('[screenshot] goto-failed ' + name + ': ' + (e && e.message));
    throw e;
  }
  // Wacht kort tot render stabiel is, geen networkidle (kan hangen)
  await page.waitForLoadState('load', { timeout: 8000 }).catch(function(e){
    console.log('[screenshot] load-timeout ' + name + ' (' + e.message + '), continuing');
  });
  await page.waitForTimeout(300);
  const out = outDir + '/' + name + '.png';
  await page.screenshot({ path: out, fullPage: false });
  console.log('[screenshot] wrote ' + out);
  await ctx.close();
}

(async function main() {
  console.log('[screenshot] launching chromium');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
    ],
  });
  console.log('[screenshot] chromium launched');
  try {
    await snap(browser, 'desktop', { width: 1440, height: 900 }, false);
    await snap(browser, 'mobile',  { width: 390,  height: 844 }, true);
  } finally {
    await browser.close();
    console.log('[screenshot] browser closed');
  }
  console.log('[screenshot] DONE');
})().catch(function(e){
  console.error('[screenshot] FATAL: ' + (e && e.message ? e.message : String(e)));
  if (e && e.stack) console.error(e.stack);
  process.exit(1);
});
`;

// -----------------------------------------------------------------------------
// Auth + rate-limit + ownership helpers (fetch-based)
// -----------------------------------------------------------------------------

interface AuthResult {
  kind: 'user' | 'dev_bypass';
  userId?: string;
  email?: string;
  jwt: string;
}

/**
 * Verify de Bearer-token. Accepteert:
 *   - Echte user-JWT → verifieer via supabase.auth.getUser (returnt user_id)
 *   - SUPABASE_SERVICE_ROLE_KEY → dev-bypass (voor dev-scripts). Deze mag NIET
 *     door frontends worden gestuurd; alleen server-side scripts (via .env.local
 *     op ontwikkelaars-machines) doen dit.
 *
 * Anonieme calls (alleen anon key of geen bearer) worden verworpen. Zonder
 * deze check kan iedereen die previewdesign4.netlify.app opent de URL zien
 * en E2B-tegoed opstoken.
 */
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
  if (!token) {
    return { error: 'empty_bearer_token', status: 401 };
  }

  // Dev-bypass via service-role-key. Constant-time-ish vergelijk.
  if (token === serviceKey) {
    return { kind: 'dev_bypass', jwt: token };
  }

  // Reject bekende publishable-key-prefixes voordat we ze naar auth/user sturen
  // (bespaart een REST-call en geeft een duidelijke fout terug).
  if (token.startsWith('sb_publishable_') || token.startsWith('sb_anon_')) {
    return { error: 'anon_key_not_accepted_use_user_jwt_or_service_role', status: 401 };
  }

  // Verifieer echte user-JWT via GoTrue /auth/v1/user.
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    return { error: `auth_verify_${r.status}`, status: 401 };
  }
  const user = (await r.json()) as { id?: string; email?: string };
  if (!user.id) {
    return { error: 'auth_no_user_id', status: 401 };
  }
  return { kind: 'user', userId: user.id, email: user.email, jwt: token };
}

// Rate-limit-constanten. Runtime-server-side afgedwongen, niet in SQL.
const RATE_LIMIT_MAX_CONCURRENT = 5;      // per user
const RATE_LIMIT_MAX_PER_HOUR   = 30;     // per user

async function checkRateLimits(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const nowIso = new Date().toISOString();
  const hourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // Aantal ACTIVE sandboxes van deze user
  const activeR = await fetch(
    `${supabaseUrl}/rest/v1/sandbox_runs?select=id&user_id=eq.${userId}&status=eq.active`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'count=exact' } },
  );
  if (!activeR.ok) {
    return { ok: false, error: `rate_check_active_${activeR.status}` };
  }
  const activeCount = Number(activeR.headers.get('content-range')?.split('/').pop() ?? '0');
  if (activeCount >= RATE_LIMIT_MAX_CONCURRENT) {
    return { ok: false, error: `rate_limit_concurrent_reached_${activeCount}_${RATE_LIMIT_MAX_CONCURRENT}` };
  }

  // Aantal runs in laatste uur
  const hourR = await fetch(
    `${supabaseUrl}/rest/v1/sandbox_runs?select=id&user_id=eq.${userId}&created_at=gte.${hourAgoIso}`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Prefer: 'count=exact' } },
  );
  if (!hourR.ok) {
    return { ok: false, error: `rate_check_hour_${hourR.status}` };
  }
  const hourCount = Number(hourR.headers.get('content-range')?.split('/').pop() ?? '0');
  if (hourCount >= RATE_LIMIT_MAX_PER_HOUR) {
    return { ok: false, error: `rate_limit_hourly_reached_${hourCount}_${RATE_LIMIT_MAX_PER_HOUR}` };
  }

  // Anti-warning: `nowIso` niet direct gebruikt — voor toekomst (daily-cap).
  void nowIso;
  return { ok: true };
}

async function recordSandboxRun(
  supabaseUrl: string,
  serviceKey: string,
  userId: string,
  sandboxId: string,
  purpose: string,
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/sandbox_runs`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ user_id: userId, sandbox_id: sandboxId, purpose, status: 'active' }),
  }).catch(() => { /* fail-open — sandbox is al gestart */ });
}

async function assertSandboxOwnership(
  supabaseUrl: string,
  serviceKey: string,
  auth: AuthResult,
  sandboxId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (auth.kind === 'dev_bypass') return { ok: true };
  const r = await fetch(
    `${supabaseUrl}/rest/v1/sandbox_runs?select=user_id&sandbox_id=eq.${encodeURIComponent(sandboxId)}`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  if (!r.ok) return { ok: false, error: `ownership_check_${r.status}`, status: 500 };
  const rows = (await r.json()) as Array<{ user_id: string }>;
  if (rows.length === 0) return { ok: false, error: 'sandbox_id_not_found_or_no_ownership_record', status: 404 };
  if (rows[0].user_id !== auth.userId) return { ok: false, error: 'sandbox_ownership_mismatch', status: 403 };
  return { ok: true };
}

async function markSandboxDestroyed(
  supabaseUrl: string,
  serviceKey: string,
  sandboxId: string,
): Promise<void> {
  await fetch(
    `${supabaseUrl}/rest/v1/sandbox_runs?sandbox_id=eq.${encodeURIComponent(sandboxId)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ status: 'destroyed', destroyed_at: new Date().toISOString() }),
    },
  ).catch(() => { /* fail-open */ });
}

// -----------------------------------------------------------------------------
// Storage helpers (fetch-based, geen supabase-js)
// -----------------------------------------------------------------------------

async function signedDownloadUrl(
  supabaseUrl: string,
  serviceKey: string,
  bucket: string,
  path: string,
  expiresIn: number,
): Promise<string> {
  const url = `${supabaseUrl}/storage/v1/object/sign/${bucket}/${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn }),
  });
  if (!r.ok) throw new Error(`signed_download_${r.status}: ${await r.text()}`);
  const j = await r.json() as { signedURL?: string; signedUrl?: string };
  const suffix = j.signedURL || j.signedUrl;
  if (!suffix) throw new Error(`signed_download_no_url_in_response: ${JSON.stringify(j)}`);
  return `${supabaseUrl}/storage/v1${suffix}`;
}

async function signedUploadUrl(
  supabaseUrl: string,
  serviceKey: string,
  bucket: string,
  path: string,
): Promise<string> {
  const url = `${supabaseUrl}/storage/v1/object/upload/sign/${bucket}/${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      'Content-Type': 'application/json',
      'x-upsert': 'true',
    },
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(`signed_upload_${r.status}: ${await r.text()}`);
  const j = await r.json() as { url?: string };
  if (!j.url) throw new Error(`signed_upload_no_url_in_response: ${JSON.stringify(j)}`);
  return `${supabaseUrl}/storage/v1${j.url}`;
}

// -----------------------------------------------------------------------------
// Step-runner
// -----------------------------------------------------------------------------

interface StepLog {
  step: string;
  ms: number;
  exit_code: number;
  stdout_tail: string;
  stderr_tail: string;
}

async function runStep(
  sandbox: Sandbox,
  label: string,
  cmd: string,
  timeoutMs: number,
  logs: StepLog[],
  timings: Record<string, number>,
  allowFailure = false,
): Promise<boolean> {
  const t = Date.now();
  // Streaming buffers — deze accumuleren *tijdens* de run, zodat we bij een
  // timeout-kill toch de laatste output hebben (niet blank zoals eerder).
  let liveStdout = '';
  let liveStderr = '';
  let stdout = '';
  let stderr = '';
  let exit = -1;
  try {
    const r = await sandbox.commands.run(cmd, {
      timeoutMs,
      onStdout: (data: string) => { liveStdout += data; },
      onStderr: (data: string) => { liveStderr += data; },
    });
    stdout = r.stdout || liveStdout;
    stderr = r.stderr || liveStderr;
    exit = r.exitCode ?? -1;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; exitCode?: number; message?: string };
    stdout = err.stdout || liveStdout;
    stderr = (err.stderr || liveStderr) + (err.message ? '\n---SDK error---\n' + err.message : '');
    exit = typeof err.exitCode === 'number' ? err.exitCode : -1;
  }
  const ms = Date.now() - t;
  timings[`step_${label}_ms`] = ms;
  logs.push({
    step: label,
    ms,
    exit_code: exit,
    stdout_tail: stdout.slice(-1800),
    stderr_tail: stderr.slice(-1200),
  });
  return exit === 0 || allowFailure;
}

// -----------------------------------------------------------------------------
// Phase handlers
// -----------------------------------------------------------------------------

async function handlePrepare(
  apiKey: string,
  supabaseUrl: string,
  serviceKey: string,
  auth: AuthResult,
) {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const logs: StepLog[] = [];

  // Rate-limit check VOOR sandbox-create (dev-bypass slaat over)
  if (auth.kind === 'user' && auth.userId) {
    const rl = await checkRateLimits(supabaseUrl, serviceKey, auth.userId);
    if (!rl.ok) {
      return {
        ok: false,
        phase: 'prepare',
        error: rl.error,
        duration_total_ms: Date.now() - t0,
        timings,
        logs,
      };
    }
  }

  const tCreate = Date.now();
  const sandbox = await Sandbox.create({ apiKey, timeoutMs: 30 * 60 * 1000 });
  timings.sandbox_create_ms = Date.now() - tCreate;
  const sandboxId = sandbox.sandboxId;

  // Registreer ownership + rate-limit-teller (fail-open)
  if (auth.kind === 'user' && auth.userId) {
    await recordSandboxRun(supabaseUrl, serviceKey, auth.userId, sandboxId, 'engine-a-preview');
  }

  try { await sandbox.setTimeout(30 * 60 * 1000); } catch { /* ignore */ }

  const aptOk = await runStep(
    sandbox,
    'apt_deps_for_chromium',
    `sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${CHROMIUM_APT_LIBS} 2>&1 || echo "APT_FAILED_OR_NO_SUDO"`,
    120_000,
    logs,
    timings,
    true,
  );

  // E2B Hobby template heeft 478MB RAM en 0 swap — Chromium renderer OOM's
  // meteen bij newPage(). 1GB swap toevoegen geeft headroom zonder custom template.
  const swapOk = await runStep(
    sandbox,
    'add_swap',
    `sudo -n fallocate -l 1G /swapfile 2>&1 && sudo -n chmod 600 /swapfile && sudo -n mkswap /swapfile 2>&1 && sudo -n swapon /swapfile && free -h`,
    30_000,
    logs,
    timings,
    true,
  );

  const toolsOk = await runStep(
    sandbox,
    'install_playwright',
    `set -e
mkdir -p /home/user/tools
cd /home/user/tools
npm init -y > /dev/null
npm install --no-audit --no-fund playwright@1.48.0
npx --yes playwright install chromium
echo "[prepare] playwright installed:"
NODE_PATH=/home/user/tools/node_modules node -e "console.log(require('playwright/package.json').version)"
ls -1 /home/user/.cache/ms-playwright/ | head`,
    240_000,
    logs,
    timings,
  );

  return {
    ok: toolsOk,
    phase: 'prepare',
    sandbox_id: sandboxId,
    apt_ok: aptOk,
    swap_ok: swapOk,
    duration_total_ms: Date.now() - t0,
    timings,
    logs,
    next: {
      phase: 'build',
      sandbox_id: sandboxId,
    },
  };
}

async function handleBuild(
  apiKey: string,
  supabaseUrl: string,
  serviceKey: string,
  sandboxId: string,
  archivePath: string,
) {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const logs: StepLog[] = [];
  let error: string | null = null;
  let sandbox: Sandbox | null = null;

  try {
    // Signed URL voor archive-download (geen bytes in memory)
    const tUrl = Date.now();
    const archiveUrl = await signedDownloadUrl(
      supabaseUrl, serviceKey, 'sandbox-archives', archivePath, 600,
    );
    timings.signed_url_ms = Date.now() - tUrl;

    // Connect (sandbox blijft leven na deze phase)
    const tConn = Date.now();
    sandbox = await Sandbox.connect(sandboxId);
    timings.sandbox_connect_ms = Date.now() - tConn;

    const steps: Array<{ label: string; cmd: string; timeoutMs: number }> = [
      {
        label: 'download_archive',
        cmd: `set -e; curl -sSL --fail "${archiveUrl}" -o /tmp/archive.tar.gz && ls -lh /tmp/archive.tar.gz`,
        timeoutMs: 60_000,
      },
      {
        label: 'extract_archive',
        cmd: `set -e; rm -rf /home/user/build && mkdir -p /home/user/build && tar -xzf /tmp/archive.tar.gz -C /home/user/build && ls /home/user/build`,
        timeoutMs: 30_000,
      },
      {
        label: 'npm_install',
        cmd: `cd /home/user/build && npm install --legacy-peer-deps --no-audit --no-fund`,
        timeoutMs: 120_000,
      },
      {
        label: 'vite_build',
        cmd: `cd /home/user/build && npm run build`,
        timeoutMs: 90_000,
      },
    ];

    for (const s of steps) {
      const ok = await runStep(sandbox, s.label, s.cmd, s.timeoutMs, logs, timings);
      if (!ok) throw new Error(`step_failed:${s.label}`);
    }
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  // Belangrijk: geen kill! Sandbox blijft leven voor phase "capture".

  return {
    ok: !error,
    phase: 'build',
    sandbox_id: sandboxId,
    archive_path: archivePath,
    error,
    duration_total_ms: Date.now() - t0,
    timings,
    logs,
    next: { phase: 'capture', sandbox_id: sandboxId },
  };
}

async function handleExpose(apiKey: string, sandboxId: string) {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const logs: StepLog[] = [];
  let sandbox: Sandbox | null = null;
  let exposeUrl: string | null = null;
  let error: string | null = null;

  try {
    const tConn = Date.now();
    sandbox = await Sandbox.connect(sandboxId);
    timings.sandbox_connect_ms = Date.now() - tConn;

    // Start static HTTP server op :8080 en wacht tot poort luistert.
    // `nohup` + `disown` zodat proces overleeft ná deze commands.run() shell exit.
    // Als server al draait vanuit een eerdere expose, is dat prima (curl slaagt).
    const ok = await runStep(
      sandbox,
      'start_static_server',
      `bash -c '
set -e
if curl -sf -o /dev/null http://127.0.0.1:8080/; then
  echo "[expose] server already running"
else
  cd /home/user/build/dist
  nohup python3 -m http.server 8080 --bind 0.0.0.0 > /tmp/server.log 2>&1 &
  disown
  for i in $(seq 1 15); do
    if curl -sf -o /dev/null http://127.0.0.1:8080/; then
      echo "[expose] server ready after \${i}s"
      break
    fi
    sleep 1
  done
fi
curl -sf http://127.0.0.1:8080/ | head -1
'`,
      30_000,
      logs,
      timings,
    );
    if (!ok) throw new Error('step_failed:start_static_server');

    // E2B v2 SDK: getHost(port) geeft publieke URL. Fallback op oudere API-namen.
    const tHost = Date.now();
    const sb = sandbox as unknown as { getHost?: (p: number) => string | Promise<string>; getHostname?: (p: number) => string | Promise<string> };
    if (typeof sb.getHost === 'function') {
      exposeUrl = 'https://' + (await sb.getHost(8080));
    } else if (typeof sb.getHostname === 'function') {
      exposeUrl = 'https://' + (await sb.getHostname(8080));
    } else {
      throw new Error('sdk_no_getHost_or_getHostname');
    }
    timings.get_host_ms = Date.now() - tHost;
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  // Belangrijk: sandbox NIET killen — preview-host houdt hem live tot destroy.

  return {
    ok: !error,
    phase: 'expose',
    sandbox_id: sandboxId,
    expose_url: exposeUrl,
    error,
    duration_total_ms: Date.now() - t0,
    timings,
    logs,
  };
}

async function handleDestroy(apiKey: string, sandboxId: string) {
  const t0 = Date.now();
  let sandbox: Sandbox | null = null;
  let error: string | null = null;
  try {
    sandbox = await Sandbox.connect(sandboxId);
    await sandbox.kill();
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  return {
    ok: !error,
    phase: 'destroy',
    sandbox_id: sandboxId,
    error,
    duration_total_ms: Date.now() - t0,
  };
}

async function handleCapture(
  apiKey: string,
  supabaseUrl: string,
  serviceKey: string,
  sandboxId: string,
  keepAlive = false,
) {
  const t0 = Date.now();
  const jobId = crypto.randomUUID();
  const timings: Record<string, number> = {};
  const logs: StepLog[] = [];
  let screenshots: { desktop_signed_url: string; mobile_signed_url: string } | null = null;
  let error: string | null = null;
  let sandbox: Sandbox | null = null;

  try {
    // Signed upload-URLs voor de twee screenshots
    const tUp = Date.now();
    const desktopKey = `job/${jobId}/desktop.png`;
    const mobileKey  = `job/${jobId}/mobile.png`;
    const desktopUpload = await signedUploadUrl(
      supabaseUrl, serviceKey, 'sandbox-screenshots', desktopKey,
    );
    const mobileUpload = await signedUploadUrl(
      supabaseUrl, serviceKey, 'sandbox-screenshots', mobileKey,
    );
    timings.signed_upload_urls_ms = Date.now() - tUp;

    const tConn = Date.now();
    sandbox = await Sandbox.connect(sandboxId);
    timings.sandbox_connect_ms = Date.now() - tConn;

    const tWrite = Date.now();
    await sandbox.files.write('/home/user/screenshot.cjs', SCREENSHOT_SCRIPT);
    timings.write_script_ms = Date.now() - tWrite;

    const steps: Array<{ label: string; cmd: string; timeoutMs: number }> = [
      {
        label: 'serve_and_screenshot',
        // bash -x zorgt dat élke shell-regel wordt geprint naar stderr,
        // ook als daarna een command hangt. Combineert met streaming
        // onStdout/onStderr in runStep: bij timeout zien we exact welke
        // regel als laatste bereikt werd.
        cmd: `bash -x -c '
set -e
echo "[shell] start"

NODE_PATH=/home/user/tools/node_modules node -e "console.log(\\"[shell] playwright version:\\", require(\\"playwright/package.json\\").version)"

cd /home/user/build/dist
python3 -m http.server 8080 --bind 127.0.0.1 > /tmp/server.log 2>&1 &
SERVER_PID=$!
echo "[shell] http.server PID=$SERVER_PID"

for i in $(seq 1 15); do
  if curl -sf -o /dev/null http://127.0.0.1:8080/; then
    echo "[shell] http.server ready after \${i}s"
    break
  fi
  sleep 1
done

echo "[shell] index.html first-line:"
curl -sf http://127.0.0.1:8080/ | head -1 || echo "[shell] curl faalde"

cd /home/user
echo "[shell] free -h VOOR screenshot:"
free -h
echo "[shell] starting screenshot.cjs"
NODE_PATH=/home/user/tools/node_modules SCREENSHOT_URL=http://127.0.0.1:8080 OUT_DIR=/home/user node screenshot.cjs
echo "[shell] screenshot.cjs exit=$?"
echo "[shell] free -h NA screenshot:"
free -h
echo "[shell] laatste kernel-messages (OOM check):"
dmesg 2>/dev/null | tail -20 || echo "[shell] dmesg unavailable"

kill $SERVER_PID 2>/dev/null || true

ls -lh /home/user/desktop.png /home/user/mobile.png
echo "[shell] done"
'`,
        timeoutMs: 120_000,
      },
      {
        label: 'upload_desktop',
        cmd: `curl -sS -f -X PUT "${desktopUpload}" -H "Content-Type: image/png" -H "x-upsert: true" --data-binary @/home/user/desktop.png && echo "[upload] desktop OK"`,
        timeoutMs: 30_000,
      },
      {
        label: 'upload_mobile',
        cmd: `curl -sS -f -X PUT "${mobileUpload}" -H "Content-Type: image/png" -H "x-upsert: true" --data-binary @/home/user/mobile.png && echo "[upload] mobile OK"`,
        timeoutMs: 30_000,
      },
    ];

    for (const s of steps) {
      const ok = await runStep(sandbox, s.label, s.cmd, s.timeoutMs, logs, timings);
      if (!ok) throw new Error(`step_failed:${s.label}`);
    }

    // Signed download-URLs voor de resultaten
    const tDl = Date.now();
    const desktopDl = await signedDownloadUrl(
      supabaseUrl, serviceKey, 'sandbox-screenshots', desktopKey, 3600,
    );
    const mobileDl = await signedDownloadUrl(
      supabaseUrl, serviceKey, 'sandbox-screenshots', mobileKey, 3600,
    );
    timings.signed_download_urls_ms = Date.now() - tDl;

    screenshots = { desktop_signed_url: desktopDl, mobile_signed_url: mobileDl };
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  } finally {
    if (sandbox && !keepAlive) {
      try { await sandbox.kill(); } catch { /* ignore */ }
    }
  }

  return {
    ok: !error,
    phase: 'capture',
    job_id: jobId,
    sandbox_id: sandboxId,
    kept_alive: keepAlive,
    error,
    duration_total_ms: Date.now() - t0,
    timings,
    logs,
    screenshots,
  };
}

// -----------------------------------------------------------------------------
// Deno.serve entry
// -----------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const apiKey = Deno.env.get('E2B_API_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!apiKey || !supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'missing_env',
        details: {
          e2b_api_key: Boolean(apiKey),
          supabase_url: Boolean(supabaseUrl),
          supabase_service_role_key: Boolean(serviceKey),
        },
      }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  let body: { phase?: string; sandbox_id?: string; archive_path?: string; keep_alive?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_json_body' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // Auth-check voor élke phase (dev-bypass via service-role-key).
  const auth = await verifyAuth(req, supabaseUrl, serviceKey);
  if ('error' in auth) {
    return new Response(
      JSON.stringify({ ok: false, error: auth.error }),
      { status: auth.status, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }

  try {
    if (body.phase === 'prepare') {
      const result = await handlePrepare(apiKey, supabaseUrl, serviceKey, auth);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    if (body.phase === 'build') {
      if (!body.sandbox_id || !body.archive_path) {
        return new Response(
          JSON.stringify({ ok: false, error: 'build_requires_sandbox_id_and_archive_path' }),
          { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
      }
      const own = await assertSandboxOwnership(supabaseUrl, serviceKey, auth, body.sandbox_id);
      if (!own.ok) {
        return new Response(
          JSON.stringify({ ok: false, error: own.error }),
          { status: own.status, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
      }
      const result = await handleBuild(
        apiKey, supabaseUrl, serviceKey, body.sandbox_id, body.archive_path,
      );
      return new Response(JSON.stringify(result, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    if (body.phase === 'capture') {
      if (!body.sandbox_id) {
        return new Response(
          JSON.stringify({ ok: false, error: 'capture_requires_sandbox_id' }),
          { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
      }
      const own = await assertSandboxOwnership(supabaseUrl, serviceKey, auth, body.sandbox_id);
      if (!own.ok) {
        return new Response(
          JSON.stringify({ ok: false, error: own.error }),
          { status: own.status, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
      }
      const keepAlive = Boolean(body.keep_alive);
      const result = await handleCapture(
        apiKey, supabaseUrl, serviceKey, body.sandbox_id, keepAlive,
      );
      if (!keepAlive) {
        await markSandboxDestroyed(supabaseUrl, serviceKey, body.sandbox_id);
      }
      return new Response(JSON.stringify(result, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    if (body.phase === 'expose') {
      if (!body.sandbox_id) {
        return new Response(
          JSON.stringify({ ok: false, error: 'expose_requires_sandbox_id' }),
          { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
      }
      const own = await assertSandboxOwnership(supabaseUrl, serviceKey, auth, body.sandbox_id);
      if (!own.ok) {
        return new Response(
          JSON.stringify({ ok: false, error: own.error }),
          { status: own.status, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
      }
      const result = await handleExpose(apiKey, body.sandbox_id);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    if (body.phase === 'destroy') {
      if (!body.sandbox_id) {
        return new Response(
          JSON.stringify({ ok: false, error: 'destroy_requires_sandbox_id' }),
          { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
      }
      const own = await assertSandboxOwnership(supabaseUrl, serviceKey, auth, body.sandbox_id);
      if (!own.ok) {
        return new Response(
          JSON.stringify({ ok: false, error: own.error }),
          { status: own.status, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
      }
      const result = await handleDestroy(apiKey, body.sandbox_id);
      await markSandboxDestroyed(supabaseUrl, serviceKey, body.sandbox_id);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'unknown_phase',
        hint: 'POST { "phase": "prepare" | "build" | "capture" | "expose" | "destroy", ... }',
      }),
      { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } },
    );
  }
});

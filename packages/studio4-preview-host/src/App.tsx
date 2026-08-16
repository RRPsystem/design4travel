import { useState } from 'react';
import { Studio4SiteLayout } from './layout/Studio4SiteLayout';
import { HelloSection } from './sections/HelloSection';
import { MOCK_BRAND } from './mocks/brand';
import { MOCK_PAGE_CONTENT } from './mocks/pageContent';
import { LoginView } from './features/auth/LoginView';
import { useSession } from './features/auth/useSession';
import { GenerateView } from './features/generate/GenerateView';
import { SimpleView } from './features/simple/SimpleView';
import { supabase, SUPABASE_CONFIG_OK } from './lib/supabase';

/**
 * Preview-host app met auth-gate + twee modes:
 *
 *   - `mock`   : Studio4SiteLayout + HelloSection lokaal gemount met MOCK data.
 *   - `remote` : Iframe naar een live sandbox-URL (phase="expose" via de
 *                sandbox-build-trigger Edge Function).
 *
 * Zonder ingelogde sessie: LoginView (magic-link). Sinds iteratie 4c.0 vereist
 * de Edge Function een geverifieerd user-JWT — de session.access_token wordt
 * meegestuurd als Bearer.
 */

type Mode = 'mock' | 'remote' | 'generate';
type Viewport = 'desktop' | 'mobile';

const VIEWPORTS: Record<Viewport, { label: string; width: number }> = {
  desktop: { label: 'Desktop 1440', width: 1440 },
  mobile: { label: 'Mobile 390', width: 390 },
};

interface ExposeResponse {
  ok: boolean;
  phase: string;
  expose_url?: string | null;
  error?: string | null;
}

async function callSandboxTrigger(
  supabaseUrl: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<ExposeResponse> {
  const r = await fetch(`${supabaseUrl}/functions/v1/sandbox-build-trigger`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return (await r.json()) as ExposeResponse;
}

const SUPABASE_URL = (import.meta.env['VITE_SUPABASE_URL'] as string | undefined) ?? '';

export default function App() {
  const { session, loading } = useSession();

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-500 flex items-center justify-center text-sm">
        Sessie laden…
      </div>
    );
  }

  if (!SUPABASE_CONFIG_OK) {
    return (
      <div className="min-h-screen bg-gray-950 text-red-300 flex items-center justify-center text-sm p-8">
        VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY ontbreken. Zet ze in Netlify site-settings.
      </div>
    );
  }

  if (!session) {
    return <LoginView />;
  }

  // Simple mode is default (voor reisagenten). Technische testbank achter ?debug=1
  // (canoniek: project_ux_simple_mode_default in memory).
  const isDebug = new URLSearchParams(window.location.search).has('debug');
  if (!isDebug) {
    return <SimpleView accessToken={session.access_token} />;
  }
  return <AuthedApp accessToken={session.access_token} email={session.user.email ?? ''} />;
}

function AuthedApp({ accessToken, email }: { accessToken: string; email: string }) {
  const [mode, setMode] = useState<Mode>('mock');
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [transparentNav, setTransparentNav] = useState(false);
  const [sandboxId, setSandboxId] = useState('');
  const [exposeUrl, setExposeUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const vp = VIEWPORTS[viewport];

  async function expose() {
    if (!sandboxId.trim()) { setStatus('Vul een sandbox_id in'); return; }
    setBusy(true); setStatus('Sandbox exposen…');
    try {
      const r = await callSandboxTrigger(SUPABASE_URL, accessToken, {
        phase: 'expose', sandbox_id: sandboxId.trim(),
      });
      if (r.ok && r.expose_url) {
        setExposeUrl(r.expose_url); setStatus(`Live op ${r.expose_url}`); setMode('remote');
      } else {
        setStatus(`Expose faalde: ${r.error ?? 'onbekend'}`);
      }
    } catch (e) {
      setStatus(`Fetch faalde: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (!sandboxId.trim()) return;
    setBusy(true); setStatus('Sandbox destroy…');
    try {
      const r = await callSandboxTrigger(SUPABASE_URL, accessToken, {
        phase: 'destroy', sandbox_id: sandboxId.trim(),
      });
      setExposeUrl(null);
      setStatus(r.ok ? 'Sandbox destroyed.' : `Destroy faalde: ${r.error}`);
    } catch (e) {
      setStatus(`Fetch faalde: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Preview-host chrome */}
      <div className="preview-chrome px-6 py-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold tracking-wide">
            Studio4 Preview Host <span className="text-gray-500">— Design4</span>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-gray-400">Mode:</span>
              {(['mock', 'remote', 'generate'] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={
                    'rounded px-2 py-1 ' +
                    (mode === m ? 'bg-white text-gray-900' : 'bg-gray-800 text-gray-300')
                  }
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-gray-400">Viewport:</span>
              {(Object.keys(VIEWPORTS) as Viewport[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setViewport(k)}
                  className={
                    'rounded px-2 py-1 ' +
                    (viewport === k ? 'bg-white text-gray-900' : 'bg-gray-800 text-gray-300')
                  }
                >
                  {VIEWPORTS[k].label}
                </button>
              ))}
            </div>
            {mode === 'mock' && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={transparentNav}
                  onChange={(e) => setTransparentNav(e.target.checked)}
                />
                <span className="text-gray-300">transparentNav</span>
              </label>
            )}
            <div className="ml-2 pl-3 border-l border-gray-700 flex items-center gap-2 text-gray-400">
              <span title={email}>{email}</span>
              <button
                type="button"
                onClick={signOut}
                className="rounded bg-gray-800 text-gray-300 px-2 py-1 hover:bg-gray-700"
              >
                Uitloggen
              </button>
            </div>
          </div>
        </div>
        {mode === 'remote' && (
          <div className="flex items-center gap-2 text-xs">
            <input
              type="text"
              value={sandboxId}
              onChange={(e) => setSandboxId(e.target.value)}
              placeholder="sandbox_id (uit run-spike.ps1 -KeepAlive)"
              className="flex-1 rounded bg-gray-800 text-gray-100 px-3 py-1.5 border border-gray-700 focus:border-white/60 focus:outline-none"
            />
            <button
              type="button"
              onClick={expose}
              disabled={busy}
              className="rounded bg-white text-gray-900 px-3 py-1.5 font-medium disabled:opacity-50"
            >
              Expose in iframe
            </button>
            <button
              type="button"
              onClick={destroy}
              disabled={busy || !sandboxId.trim()}
              className="rounded bg-red-600 text-white px-3 py-1.5 font-medium disabled:opacity-50"
            >
              Destroy sandbox
            </button>
          </div>
        )}
        {status && (
          <div className="text-xs text-gray-400 font-mono break-all">{status}</div>
        )}
      </div>

      {/* Generate-mode: eigen surface, geen viewport-frame */}
      {mode === 'generate' && <GenerateView accessToken={accessToken} />}

      {/* Viewport-frame voor mock + remote */}
      {mode !== 'generate' && (
      <div className="flex justify-center py-6">
        <div
          className="bg-white shadow-2xl overflow-hidden"
          style={{ width: `${vp.width}px`, maxWidth: '100%' }}
        >
          {mode === 'mock' && (
            <Studio4SiteLayout brand={MOCK_BRAND} transparentNav={transparentNav}>
              <HelloSection
                brand={MOCK_BRAND}
                primaryColor={MOCK_BRAND.primary_color}
                secondaryColor={MOCK_BRAND.secondary_color}
                basePath="/"
                pageContent={MOCK_PAGE_CONTENT}
              />
            </Studio4SiteLayout>
          )}
          {mode === 'remote' && exposeUrl && (
            <iframe
              title="Sandbox live"
              src={exposeUrl}
              className="block border-0"
              style={{ width: `${vp.width}px`, height: viewport === 'mobile' ? '844px' : '900px' }}
            />
          )}
          {mode === 'remote' && !exposeUrl && (
            <div className="p-16 text-center text-gray-500 text-sm">
              Vul een sandbox_id in en klik "Expose in iframe".
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

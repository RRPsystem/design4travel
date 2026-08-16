import { useState } from 'react';
import { Studio4SiteLayout } from './layout/Studio4SiteLayout';
import { HelloSection } from './sections/HelloSection';
import { MOCK_BRAND } from './mocks/brand';
import { MOCK_PAGE_CONTENT } from './mocks/pageContent';

/**
 * Preview-host app met twee modes:
 *
 *   - `mock`   : Studio4SiteLayout + HelloSection lokaal gemount met MOCK data.
 *                Bewijst dat het SDK-contract in de preview-host werkt.
 *   - `remote` : Iframe naar een live sandbox-URL (van `phase:expose` op
 *                sandbox-build-trigger). Bewijst dat een gegenereerd pakket
 *                daadwerkelijk gerenderd wordt door Vite-build + Chromium in
 *                dezelfde pipeline die Design4 straks produceert.
 *
 * Iteratie 3: user vult sandbox_id handmatig in (uit run-spike.ps1 output).
 * Volgende iteratie: preview-host triggert de sandbox-flow zelf.
 */

type Mode = 'mock' | 'remote';
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
  anonKey: string,
  body: Record<string, unknown>,
): Promise<ExposeResponse> {
  const r = await fetch(`${supabaseUrl}/functions/v1/sandbox-build-trigger`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return (await r.json()) as ExposeResponse;
}

// Client-side config uit VITE_ env-vars. `VITE_` prefix betekent WEL in de
// frontend-bundle — anon key is public en mag daar; service_role NIET.
const SUPABASE_URL = (import.meta.env['VITE_SUPABASE_URL'] as string | undefined) ?? '';
const SUPABASE_ANON = (import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined) ?? '';

export default function App() {
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
    if (!SUPABASE_URL || !SUPABASE_ANON) {
      setStatus('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY ontbreken in .env.local'); return;
    }
    setBusy(true); setStatus('Sandbox exposen…');
    try {
      const r = await callSandboxTrigger(SUPABASE_URL, SUPABASE_ANON, {
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
      const r = await callSandboxTrigger(SUPABASE_URL, SUPABASE_ANON, {
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
              {(['mock', 'remote'] as Mode[]).map((m) => (
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
          </div>
        </div>
        {mode === 'remote' && (
          <div className="flex items-center gap-2 text-xs">
            <input
              type="text"
              value={sandboxId}
              onChange={(e) => setSandboxId(e.target.value)}
              placeholder="sandbox_id (uit run-spike.ps1 output, met keep_alive:true)"
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

      {/* Viewport-frame */}
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
    </div>
  );
}

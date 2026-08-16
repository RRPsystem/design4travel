import { useEffect, useRef, useState } from 'react';
import { Upload, Sparkles, Loader2, Monitor, Smartphone, RotateCcw } from 'lucide-react';
import { supabase } from '../../lib/supabase';

/**
 * Simple mode — de standaard-UX voor reisagenten. Zero technische ballast.
 *
 * Flow: upload voorbeeldafbeelding → typ opdracht → één knop "Ontwerp maken".
 * De hele pipeline (AI-generate → sandbox-prepare → build → expose) draait
 * automatisch met begrijpelijke Nederlandse status-updates. Preview vult
 * het hoofdgedeelte van het scherm, Desktop/Mobiel-toggle daaronder.
 * Fouten verschijnen in gewone taal met één duidelijke retry-knop.
 *
 * Sandbox wordt automatisch opgeruimd bij:
 *   - Nieuwe generatie (vorige sandbox destroy vóór nieuwe start)
 *   - Tab sluiten / navigeren (beforeunload → destroy via fetch keepalive)
 *   - 30-min E2B-timeout (fallback)
 *
 * Alle technische details (manifest.json, tokens, sandbox_id, phase-labels,
 * compare-JSON) zijn NIET zichtbaar. Voor debug: laad met ?debug=1.
 *
 * Canoniek: zie project_ux_simple_mode_default in memory.
 */

const SUPABASE_URL = (import.meta.env['VITE_SUPABASE_URL'] as string | undefined) ?? '';
const PREVIEW_SHELL_VERSION = '0.0.1';

type Phase = 'idle' | 'generating' | 'previewing' | 'error';
type Viewport = 'desktop' | 'mobile';

const VIEWPORTS: Record<Viewport, { label: string; width: number; icon: typeof Monitor }> = {
  desktop: { label: 'Desktop', width: 1440, icon: Monitor },
  mobile: { label: 'Mobiel', width: 390, icon: Smartphone },
};

// Begrijpelijke Nederlandse foutteksten — technische errors worden hier vertaald.
function friendlyError(rawError: string | null | undefined): string {
  if (!rawError) return 'Er ging iets mis. Probeer het opnieuw.';
  const r = rawError.toLowerCase();
  if (r.includes('rate_limit_concurrent')) return 'Je hebt momenteel al meerdere ontwerpen tegelijk lopen. Wacht tot een ervan klaar is.';
  if (r.includes('rate_limit_hourly')) return 'Je hebt vandaag al veel ontwerpen gemaakt. Probeer het over een uur opnieuw.';
  if (r.includes('missing_bearer_token') || r.includes('auth_verify')) return 'Je sessie is verlopen. Log opnieuw in.';
  if (r.includes('reference_path_required')) return 'Er ging iets mis met de afbeelding. Kies een ander bestand en probeer opnieuw.';
  if (r.includes('anthropic_')) return 'De AI-assistent had een probleem. Probeer het opnieuw.';
  if (r.includes('step_failed')) return 'Het bouwen van je ontwerp mislukte. Probeer opnieuw met een andere afbeelding of opdracht.';
  return 'Er ging iets mis. Probeer het opnieuw.';
}

export function SimpleView({ accessToken }: { accessToken: string }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState('');
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [exposeUrl, setExposeUrl] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const activeSandboxId = useRef<string | null>(null);

  // Destroy sandbox bij tab-sluiten. Gebruik fetch met keepalive zodat de call
  // ook bij page-unload doorgaat (i.p.v. sendBeacon die geen Authorization
  // header kan zetten voor CORS).
  useEffect(() => {
    function onUnload() {
      const sid = activeSandboxId.current;
      if (!sid) return;
      try {
        fetch(`${SUPABASE_URL}/functions/v1/sandbox-build-trigger`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ phase: 'destroy', sandbox_id: sid }),
          keepalive: true,
        });
      } catch { /* ignore */ }
    }
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [accessToken]);

  async function destroyIfActive() {
    const sid = activeSandboxId.current;
    activeSandboxId.current = null;
    if (!sid) return;
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/sandbox-build-trigger`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'destroy', sandbox_id: sid }),
      });
    } catch { /* ignore */ }
  }

  async function createDesign() {
    if (!file) return;

    // Nieuwe generatie: vorige sandbox eerst opruimen
    if (activeSandboxId.current) await destroyIfActive();
    setExposeUrl(null);
    setErrorText(null);
    setPhase('generating');

    try {
      // 1. Reference uploaden
      setStatusText('Je voorbeeld verwerken…');
      const path = `${crypto.randomUUID()}-${file.name}`;
      const upl = await supabase.storage
        .from('design-references')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upl.error) throw new Error(`upload_${upl.error.message}`);

      // 2. AI genereert pakket
      setStatusText('AI ontwerpt je component…');
      const genR = await fetch(`${SUPABASE_URL}/functions/v1/generate-studio4-component`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference_path: path, chat_prompt: prompt, fixture_hint: '' }),
      }).then((r) => r.json());
      if (!genR.ok || !genR.final_package) throw new Error(genR.error ?? 'generate_failed');

      // 3. Sandbox aanmaken
      setStatusText('Voorbereiden preview-omgeving…');
      const prep = await fetch(`${SUPABASE_URL}/functions/v1/sandbox-build-trigger`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'prepare' }),
      }).then((r) => r.json());
      if (!prep.ok || !prep.sandbox_id) throw new Error(prep.error ?? 'prepare_failed');
      activeSandboxId.current = prep.sandbox_id as string;

      // 4. Build in sandbox
      setStatusText('Ontwerp bouwen…');
      const build = await fetch(`${SUPABASE_URL}/functions/v1/sandbox-build-trigger`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phase: 'build_from_ai',
          sandbox_id: prep.sandbox_id,
          manifest: genR.final_package.manifest,
          component_tsx: genR.final_package.componentTsx,
          preview_shell_version: PREVIEW_SHELL_VERSION,
          fixture_path: null,
        }),
      }).then((r) => r.json());
      if (!build.ok) throw new Error(build.error ?? 'build_failed');

      // 5. Expose
      setStatusText('Live zetten…');
      const exp = await fetch(`${SUPABASE_URL}/functions/v1/sandbox-build-trigger`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'expose', sandbox_id: prep.sandbox_id }),
      }).then((r) => r.json());
      if (!exp.ok || !exp.expose_url) throw new Error(exp.error ?? 'expose_failed');

      setExposeUrl(exp.expose_url as string);
      setStatusText('');
      setPhase('previewing');
    } catch (e) {
      setErrorText(friendlyError((e as Error).message));
      setPhase('error');
      await destroyIfActive();
    }
  }

  function reset() {
    destroyIfActive();
    setFile(null);
    setPrompt('');
    setExposeUrl(null);
    setErrorText(null);
    setStatusText('');
    setPhase('idle');
  }

  const vp = VIEWPORTS[viewport];

  // -------- render --------

  if (phase === 'generating') {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-6">
        <div className="max-w-md w-full text-center space-y-6">
          <Loader2 className="h-10 w-10 animate-spin mx-auto text-gray-400" />
          <div className="text-lg font-semibold">{statusText || 'Bezig…'}</div>
          <div className="text-sm text-gray-500">
            Dit duurt normaal 60-90 seconden. Blijf op deze pagina.
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-6">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="text-2xl font-bold">Oeps</div>
          <div className="text-gray-300">{errorText}</div>
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 rounded bg-white text-gray-900 px-5 py-2.5 font-semibold"
          >
            <RotateCcw className="h-4 w-4" />
            Opnieuw proberen
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'previewing' && exposeUrl) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
        <div className="border-b border-gray-800 px-6 py-3 flex items-center justify-between">
          <div className="text-sm font-semibold">Je ontwerp</div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 rounded bg-gray-900 border border-gray-800 p-1">
              {(Object.keys(VIEWPORTS) as Viewport[]).map((k) => {
                const V = VIEWPORTS[k];
                const Icon = V.icon;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setViewport(k)}
                    className={
                      'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium ' +
                      (viewport === k ? 'bg-white text-gray-900' : 'text-gray-400 hover:text-gray-200')
                    }
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {V.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-2 rounded bg-gray-800 hover:bg-gray-700 text-gray-100 px-3 py-1.5 text-xs font-medium"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Opnieuw proberen
            </button>
          </div>
        </div>
        <div className="flex-1 flex items-start justify-center py-6 px-6 overflow-auto">
          <div
            className="bg-white shadow-2xl overflow-hidden"
            style={{ width: `${vp.width}px`, maxWidth: '100%' }}
          >
            <iframe
              title="Je ontwerp"
              src={exposeUrl}
              className="block border-0"
              style={{ width: `${vp.width}px`, height: viewport === 'mobile' ? '844px' : '900px' }}
            />
          </div>
        </div>
        <div className="border-t border-gray-800 px-6 py-3 flex items-center justify-end gap-2 text-xs">
          <button
            type="button"
            disabled
            className="rounded bg-gray-800 text-gray-500 px-3 py-1.5 cursor-not-allowed"
            title="Binnenkort beschikbaar"
          >
            Opslaan als template
          </button>
          <button
            type="button"
            disabled
            className="rounded bg-gray-800 text-gray-500 px-3 py-1.5 cursor-not-allowed"
            title="Binnenkort beschikbaar"
          >
            Gebruiken in Studio4
          </button>
        </div>
      </div>
    );
  }

  // idle → invoerform
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-6 py-12">
      <div className="max-w-xl w-full space-y-6">
        <div>
          <div className="text-xs uppercase tracking-widest text-gray-500 mb-1">Design4 · Ontwerp</div>
          <h1 className="text-3xl font-bold">Maak een nieuw ontwerp</h1>
          <p className="mt-2 text-sm text-gray-400">
            Upload een voorbeeldafbeelding en beschrijf wat je wilt. AI maakt er een reisontwerp van dat direct in je browser draait.
          </p>
        </div>

        <div className="space-y-4 rounded bg-gray-900 border border-gray-800 p-4">
          <div>
            <label className="block text-xs uppercase tracking-widest text-gray-500 mb-2">
              Voorbeeldafbeelding
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer rounded bg-gray-800 border border-gray-700 px-3 py-2 hover:bg-gray-700">
              <Upload className="h-4 w-4" />
              <span className="text-sm">{file ? file.name : 'Kies bestand…'}</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-widest text-gray-500 mb-2">
              Wat wil je maken?
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder='Bijv. "Maak een safari-hero met warme aardetinten en een grote transparante achtergrondtekst"'
              className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-white/60 focus:outline-none min-h-[100px]"
            />
          </div>

          <button
            type="button"
            onClick={createDesign}
            disabled={!file}
            className="w-full inline-flex items-center justify-center gap-2 rounded bg-white text-gray-900 px-4 py-3 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Sparkles className="h-4 w-4" />
            Ontwerp maken
          </button>
        </div>
      </div>
    </div>
  );
}

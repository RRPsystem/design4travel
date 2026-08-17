import { useEffect, useRef, useState } from 'react';
import { Upload, Sparkles, Loader2, Monitor, Smartphone, RotateCcw, Send, Check, Bookmark } from 'lucide-react';
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
  if (r.includes('rate_limit_concurrent')) return 'Er lopen momenteel te veel ontwerpen tegelijk. Wacht een paar minuten en probeer opnieuw — oude sessies worden automatisch opgeruimd.';
  if (r.includes('rate_limit_hourly')) return 'Je hebt vandaag al veel ontwerpen gemaakt. Probeer het over een uur opnieuw.';
  if (r.includes('missing_bearer_token') || r.includes('auth_verify') || r.includes('sessie is verlopen')) return 'Je sessie is verlopen. Log opnieuw in.';
  if (r.includes('reference_path_required')) return 'Er ging iets mis met de afbeelding. Kies een ander bestand en probeer opnieuw.';
  if (r.includes('sandbox_ownership_mismatch') || r.includes('sandbox_id_not_found')) return 'De voorbeeldomgeving is verlopen. Klik "Opnieuw proberen" om opnieuw te beginnen.';
  if (r.includes('sandbox_connect') || r.includes('sandbox is not running')) return 'De voorbeeldomgeving is verlopen. Klik "Opnieuw proberen" om opnieuw te beginnen.';
  if (r.includes('deadline_exceeded') || r.includes('timeout')) return 'Het duurde te lang. Probeer opnieuw met een eenvoudigere opdracht.';
  if (r.includes('anthropic_')) return 'De AI-assistent had een probleem. Probeer het opnieuw.';
  if (r.includes('no_tool_use_in_response')) return 'De AI gaf een onvolledig antwoord. Probeer je opdracht anders te formuleren.';
  if (r.includes('step_failed')) return 'Het bouwen van je ontwerp mislukte. Probeer opnieuw met een andere afbeelding of opdracht.';
  return 'Er ging iets mis. Probeer het opnieuw.';
}

interface PkgFiles { manifest: Record<string, unknown>; componentTsx: string; }
interface CompareFeedback {
  match_score: number;
  summary: string;
  differences: Array<{ area: string; severity: string; suggestion: string }>;
}

export function SimpleView({ accessToken }: { accessToken: string }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState('');
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [exposeUrl, setExposeUrl] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0); // force iframe reload bij revise
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const activeSandboxId = useRef<string | null>(null);

  // Revise/chat + auto-repair
  const [currentPackage, setCurrentPackage] = useState<PkgFiles | null>(null);
  const [referencePath, setReferencePath] = useState<string | null>(null);
  const [captureJobId, setCaptureJobId] = useState<string | null>(null);
  const autoRepairedRef = useRef<boolean>(false); // max 1 auto-repair per generate
  const [chatInput, setChatInput] = useState('');
  const [reviseBusy, setReviseBusy] = useState(false);
  const [reviseStatus, setReviseStatus] = useState<string>('');
  const [reviseRawError, setReviseRawError] = useState<string | null>(null);
  const [autoRepairBusy, setAutoRepairBusy] = useState(false);

  // Save-as-template
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveDone, setSaveDone] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

    // Nieuwe generatie: vorige sandbox eerst opruimen + state reset
    if (activeSandboxId.current) await destroyIfActive();
    setExposeUrl(null);
    setErrorText(null);
    setCurrentPackage(null);
    setReferencePath(null);
    setCaptureJobId(null);
    autoRepairedRef.current = false;
    setPhase('generating');

    try {
      // 1. Reference uploaden
      setStatusText('Je voorbeeld verwerken…');
      const path = `${crypto.randomUUID()}-${file.name}`;
      const upl = await supabase.storage
        .from('design-references')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upl.error) throw new Error(`upload_${upl.error.message}`);
      setReferencePath(path);

      // 2. AI genereert pakket
      setStatusText('AI ontwerpt je component…');
      const genR = await fetch(`${SUPABASE_URL}/functions/v1/generate-studio4-component`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference_path: path, chat_prompt: prompt, fixture_hint: '' }),
      }).then((r) => r.json());
      if (!genR.ok || !genR.final_package) throw new Error(genR.error ?? 'generate_failed');
      setCurrentPackage(genR.final_package as PkgFiles);

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

      // 5. Capture (keep_alive) — screenshot voor auto-repair-vergelijking
      setStatusText('Screenshots maken…');
      const cap = await fetch(`${SUPABASE_URL}/functions/v1/sandbox-build-trigger`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'capture', sandbox_id: prep.sandbox_id, keep_alive: true }),
      }).then((r) => r.json());
      if (cap.ok && cap.job_id) setCaptureJobId(cap.job_id as string);

      // 6. Expose
      setStatusText('Live zetten…');
      const exp = await fetch(`${SUPABASE_URL}/functions/v1/sandbox-build-trigger`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: 'expose', sandbox_id: prep.sandbox_id }),
      }).then((r) => r.json());
      if (!exp.ok || !exp.expose_url) throw new Error(exp.error ?? 'expose_failed');

      setExposeUrl(exp.expose_url as string);
      setIframeKey((k) => k + 1);
      setStatusText('');
      setPhase('previewing');
    } catch (e) {
      setErrorText(friendlyError((e as Error).message));
      setPhase('error');
      await destroyIfActive();
    }
  }

  /**
   * Auto-repair: nadat preview live is, silently vraag Claude vision om te
   * vergelijken; als match_score < 60 met een critical/significant issue,
   * doe één auto-repair (nieuwe generate met previous_package + feedback).
   */
  useEffect(() => {
    if (phase !== 'previewing') return;
    if (autoRepairedRef.current) return;
    if (!referencePath || !captureJobId || !currentPackage) return;

    autoRepairedRef.current = true; // slechts één poging per generate
    (async () => {
      setAutoRepairBusy(true);
      try {
        const compR = await fetch(`${SUPABASE_URL}/functions/v1/visual-compare`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reference_path: referencePath,
            screenshot_path: `job/${captureJobId}/desktop.png`,
          }),
        }).then((r) => r.json());
        if (!compR.ok || !compR.feedback) return;
        const fb = compR.feedback as CompareFeedback;
        const needsRepair =
          fb.match_score < 60 &&
          fb.differences.some((d) => d.severity === 'critical' || d.severity === 'significant');
        if (!needsRepair) return;

        // Auto-repair: nieuwe generate met previous package + feedback
        await runRevision('', fb, /* isAutoRepair */ true);
      } catch { /* fail-open */ }
      finally {
        setAutoRepairBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, referencePath, captureJobId, currentPackage]);

  /**
   * POST helper: doet fetch, geeft duidelijke error terug ALS response niet ok
   * of body geen ok:true heeft. Zo krijgen we consistente errors i.p.v. silent
   * "Unexpected end of JSON input" bij 500-HTML-responses.
   */
  async function postEdge(fn: string, body: unknown): Promise<Record<string, unknown>> {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* ignore */ }
    if (!r.ok) {
      const errStr = (json?.error as string | undefined) ?? text.slice(0, 300) ?? `http_${r.status}`;
      throw new Error(`${fn}: HTTP ${r.status} — ${errStr}`);
    }
    if (json && json.ok === false) {
      throw new Error(`${fn}: ${(json.error as string | undefined) ?? 'ok=false'}`);
    }
    return json ?? {};
  }

  async function runRevision(
    userPrompt: string,
    feedback: CompareFeedback | null,
    isAutoRepair: boolean,
  ) {
    if (!currentPackage || !referencePath || !activeSandboxId.current) return;
    const sid = activeSandboxId.current;
    if (!isAutoRepair) setReviseBusy(true);
    setReviseStatus(isAutoRepair ? 'AI verfijnt je ontwerp…' : 'AI past je ontwerp aan…');
    setReviseRawError(null);
    // Nieuwe versie → oude 'opgeslagen'-badge is niet meer geldig
    setSaveDone(false);

    try {
      // 1. generate met previous_package
      const genR = await postEdge('generate-studio4-component', {
        reference_path: referencePath,
        chat_prompt: userPrompt,
        fixture_hint: '',
        previous_package: currentPackage,
        previous_feedback: feedback ?? undefined,
      });
      const finalPkg = genR.final_package as PkgFiles | undefined;
      if (!finalPkg) throw new Error('generate: geen final_package in respons');
      setCurrentPackage(finalPkg);

      // 2. rebuild in bestaande sandbox
      setReviseStatus('Aanpassing bouwen…');
      await postEdge('sandbox-build-trigger', {
        phase: 'build_from_ai',
        sandbox_id: sid,
        manifest: finalPkg.manifest,
        component_tsx: finalPkg.componentTsx,
        preview_shell_version: PREVIEW_SHELL_VERSION,
        fixture_path: null,
      });

      // 3. expose (python server draait al; getHost is idempotent) + iframe reload
      const exp = await postEdge('sandbox-build-trigger', { phase: 'expose', sandbox_id: sid });
      if (exp.expose_url) setExposeUrl(exp.expose_url as string);
      setIframeKey((k) => k + 1);
      setReviseStatus('');
    } catch (e) {
      const raw = (e as Error).message;
      // eslint-disable-next-line no-console
      console.error('[Design4 revise] raw error:', raw);
      setReviseRawError(raw);
      setReviseStatus(`Kon aanpassing niet uitvoeren: ${friendlyError(raw)}`);
    } finally {
      if (!isAutoRepair) setReviseBusy(false);
    }
  }

  async function sendChat() {
    const text = chatInput.trim();
    if (!text || reviseBusy) return;
    setChatInput('');
    await runRevision(text, null, false);
  }

  /**
   * Slaat huidig pakket op als template. Insert gaat direct via supabase-js
   * met user-JWT; RLS in migratie 0021 zorgt dat owner_user_id niet spoofbaar
   * is. Slug wordt afgeleid van naam (lowercase, spaties → '-', overige
   * chars gestript). Bij naamconflict binnen owner: friendly error.
   */
  async function saveTemplate() {
    if (!currentPackage) return;
    const name = saveName.trim();
    if (name.length < 1 || name.length > 120) {
      setSaveError('Geef je ontwerp een naam (1-120 tekens).');
      return;
    }
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    if (!slug) {
      setSaveError('Deze naam kan niet gebruikt worden. Probeer een andere.');
      return;
    }

    setSaveBusy(true);
    setSaveError(null);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (!uid) throw new Error('Je sessie is verlopen. Log opnieuw in.');

      const { error } = await supabase.from('design_templates').insert({
        owner_user_id: uid,
        name,
        slug,
        manifest: currentPackage.manifest,
        component_tsx: currentPackage.componentTsx,
        reference_path: referencePath,
      });
      if (error) {
        if (error.code === '23505') {
          throw new Error('Je hebt al een template met deze naam. Kies een andere naam.');
        }
        throw new Error(error.message);
      }
      setSaveDone(true);
      setSaveOpen(false);
      setSaveName('');
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaveBusy(false);
    }
  }

  function reset() {
    destroyIfActive();
    setFile(null);
    setPrompt('');
    setExposeUrl(null);
    setErrorText(null);
    setStatusText('');
    setCurrentPackage(null);
    setReferencePath(null);
    setCaptureJobId(null);
    setChatInput('');
    setReviseStatus('');
    setSaveOpen(false);
    setSaveName('');
    setSaveDone(false);
    setSaveError(null);
    autoRepairedRef.current = false;
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
        {(autoRepairBusy || reviseBusy || reviseStatus) && (
          <div className="border-b border-gray-800 bg-gray-900 px-6 py-2 space-y-1 text-xs text-gray-300">
            <div className="flex items-center gap-2">
              {(autoRepairBusy || reviseBusy) && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>{reviseStatus || 'AI verfijnt je ontwerp…'}</span>
            </div>
            {reviseRawError && (
              <details className="text-[10px] text-gray-500">
                <summary className="cursor-pointer">Technische details</summary>
                <div className="mt-1 font-mono break-all whitespace-pre-wrap">{reviseRawError}</div>
              </details>
            )}
          </div>
        )}
        <div className="flex-1 flex items-start justify-center py-6 px-6 overflow-auto">
          <div
            className="bg-white shadow-2xl overflow-hidden"
            style={{ width: `${vp.width}px`, maxWidth: '100%' }}
          >
            <iframe
              key={iframeKey}
              title="Je ontwerp"
              src={exposeUrl}
              className="block border-0"
              style={{ width: `${vp.width}px`, height: viewport === 'mobile' ? '844px' : '900px' }}
            />
          </div>
        </div>
        {/* Chat voor vervolgwijzigingen */}
        <div className="border-t border-gray-800 px-6 py-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
              }}
              placeholder='Wijzig iets, bv. "titel groter" of "gebruik warmere kleuren"…'
              disabled={reviseBusy || autoRepairBusy}
              className="flex-1 rounded bg-gray-900 border border-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-white/60 focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={sendChat}
              disabled={reviseBusy || autoRepairBusy || !chatInput.trim()}
              className="inline-flex items-center gap-2 rounded bg-white text-gray-900 px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {reviseBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Verzenden
            </button>
          </div>
        </div>
        <div className="border-t border-gray-800 px-6 py-3 flex flex-col gap-2 text-xs">
          {saveOpen && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveTemplate(); }
                  if (e.key === 'Escape') { setSaveOpen(false); setSaveError(null); }
                }}
                placeholder='Naam, bv. "Safari hero warm"'
                disabled={saveBusy}
                autoFocus
                className="flex-1 rounded bg-gray-900 border border-gray-800 px-3 py-1.5 text-xs text-gray-100 focus:border-white/60 focus:outline-none disabled:opacity-50"
              />
              <button
                type="button"
                onClick={saveTemplate}
                disabled={saveBusy || !saveName.trim()}
                className="inline-flex items-center gap-1.5 rounded bg-white text-gray-900 px-3 py-1.5 font-semibold disabled:opacity-50"
              >
                {saveBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bookmark className="h-3.5 w-3.5" />}
                Bewaren
              </button>
              <button
                type="button"
                onClick={() => { setSaveOpen(false); setSaveError(null); }}
                disabled={saveBusy}
                className="rounded bg-gray-800 hover:bg-gray-700 text-gray-100 px-3 py-1.5 disabled:opacity-50"
              >
                Annuleren
              </button>
            </div>
          )}
          {saveError && (
            <div className="text-red-400">{saveError}</div>
          )}
          <div className="flex items-center justify-end gap-2">
            {saveDone && (
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                Opgeslagen
              </span>
            )}
            <button
              type="button"
              onClick={() => { setSaveOpen((v) => !v); setSaveError(null); }}
              disabled={!currentPackage || reviseBusy || autoRepairBusy}
              className="inline-flex items-center gap-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-100 px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Bookmark className="h-3.5 w-3.5" />
              {saveOpen ? 'Sluiten' : 'Opslaan als template'}
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

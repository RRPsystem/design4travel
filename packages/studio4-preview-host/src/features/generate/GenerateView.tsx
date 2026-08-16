import { useState } from 'react';
import { Upload, Sparkles, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';

/**
 * Generate-mode voor de preview-host.
 * Flow:
 *   1. User upload een reference-image (screenshot van bestaande site / moodboard)
 *      → naar `design-references` bucket, path `<uuid>-<filename>`
 *   2. User geeft optionele chat-prompt en fixture-hint
 *   3. Click "Genereer" → POST naar generate-studio4-component Edge Function
 *   4. UI toont per iteratie: model, latency, tokens, validation-result
 *   5. Bij success: files (manifest.json + Component.tsx) in <pre>-viewer met
 *      copy-to-clipboard-knoppen. User kan daarna via build-component-archive
 *      + upload naar sandbox-archives + preview (4c.2 automatiseert dit).
 */

const SUPABASE_URL = (import.meta.env['VITE_SUPABASE_URL'] as string | undefined) ?? '';

interface GenerationLog {
  iteration: number;
  model: string;
  latency_ms: number;
  tokens_in?: number;
  tokens_out?: number;
  validation: {
    ok: boolean;
    issues: Array<{ severity: string; rule: string; message: string; location?: { file?: string } }>;
    errorCount: number;
    warningCount: number;
  };
}

interface GenerateResponse {
  ok: boolean;
  parent_call_id: string;
  duration_total_ms: number;
  iterations_used: number;
  max_iterations: number;
  error?: string | null;
  generation_log: GenerationLog[];
  final_package?: { manifest: Record<string, unknown>; componentTsx: string } | null;
  final_validation?: { ok: boolean; errorCount: number; issues: Array<{ severity: string; rule: string; message: string }> } | null;
}

export function GenerateView({ accessToken }: { accessToken: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [chatPrompt, setChatPrompt] = useState('');
  const [fixtureHint, setFixtureHint] = useState('safari-fixture: title "Safari Zuid-Afrika & strand Mauritius", 14 dagen Kruger + Mauritius');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [result, setResult] = useState<GenerateResponse | null>(null);

  async function generate() {
    if (!file) { setStatus('Kies eerst een reference-image'); return; }
    setBusy(true);
    setResult(null);

    try {
      // 1. Upload reference naar design-references bucket
      setStatus('Reference uploaden…');
      const path = `${crypto.randomUUID()}-${file.name}`;
      const upl = await supabase.storage
        .from('design-references')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upl.error) { setStatus(`Upload faalde: ${upl.error.message}`); setBusy(false); return; }

      // 2. Call Edge Function
      setStatus('Claude analyseert reference + genereert pakket… (kan 30-90s duren)');
      const r = await fetch(`${SUPABASE_URL}/functions/v1/generate-studio4-component`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reference_path: path,
          chat_prompt: chatPrompt,
          fixture_hint: fixtureHint,
        }),
      });
      const data = (await r.json()) as GenerateResponse;
      setResult(data);
      setStatus(data.ok
        ? `Success in ${data.iterations_used} iteratie(s), ${data.duration_total_ms}ms`
        : `Faalde: ${data.error ?? 'validation-errors'} (${data.iterations_used}/${data.max_iterations} iteraties)`);
    } catch (e) {
      setStatus(`Fetch faalde: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 text-gray-100 space-y-6">
      <div>
        <div className="text-xs uppercase tracking-widest text-gray-500 mb-1">Generate-mode</div>
        <h2 className="text-xl font-bold">AI genereert een Studio4-component</h2>
        <p className="mt-2 text-sm text-gray-400">
          Upload een design-referentie + optionele instructies. Claude Sonnet 5 vision genereert
          een manifest + TSX-source conform SDK v1.0. Bij validator-errors: automatisch één repair-turn
          met Opus 5 (max {3} iteraties).
        </p>
      </div>

      <div className="space-y-4 bg-gray-900 border border-gray-800 rounded p-4">
        <div>
          <label className="block text-xs uppercase tracking-widest text-gray-500 mb-1">
            Reference-image
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
          <label className="block text-xs uppercase tracking-widest text-gray-500 mb-1">
            Chat-prompt (optioneel)
          </label>
          <textarea
            value={chatPrompt}
            onChange={(e) => setChatPrompt(e.target.value)}
            placeholder='bv. "Maak deze na, maar in warme aardetinten en met een grote transparante achtergrondtekst"'
            className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-gray-100 focus:border-white/60 focus:outline-none min-h-[80px]"
          />
        </div>

        <div>
          <label className="block text-xs uppercase tracking-widest text-gray-500 mb-1">
            Fixture-hint (welke reisdata wordt straks gebonden)
          </label>
          <input
            type="text"
            value={fixtureHint}
            onChange={(e) => setFixtureHint(e.target.value)}
            className="w-full rounded bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 focus:border-white/60 focus:outline-none"
          />
        </div>

        <button
          type="button"
          onClick={generate}
          disabled={busy || !file}
          className="inline-flex items-center gap-2 rounded bg-white text-gray-900 px-4 py-2 font-semibold disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {busy ? 'Bezig…' : 'Genereer pakket'}
        </button>

        {status && (
          <div className="text-xs text-gray-400 font-mono break-all">{status}</div>
        )}
      </div>

      {result && (
        <div className="space-y-4">
          {/* Iteratie-log */}
          <div className="bg-gray-900 border border-gray-800 rounded p-4">
            <div className="text-xs uppercase tracking-widest text-gray-500 mb-2">Iteratie-log</div>
            <table className="text-xs w-full">
              <thead className="text-gray-500">
                <tr>
                  <th className="text-left pr-3">#</th>
                  <th className="text-left pr-3">Model</th>
                  <th className="text-right pr-3">Latency</th>
                  <th className="text-right pr-3">Tokens (in→out)</th>
                  <th className="text-left">Validator</th>
                </tr>
              </thead>
              <tbody className="text-gray-200">
                {result.generation_log.map((l) => (
                  <tr key={l.iteration} className="border-t border-gray-800">
                    <td className="pr-3 py-1">{l.iteration}</td>
                    <td className="pr-3 py-1 font-mono">{l.model}</td>
                    <td className="pr-3 py-1 text-right">{l.latency_ms}ms</td>
                    <td className="pr-3 py-1 text-right font-mono">
                      {l.tokens_in ?? '?'} → {l.tokens_out ?? '?'}
                    </td>
                    <td className="py-1">
                      {l.validation.ok
                        ? <span className="text-green-400">ok</span>
                        : <span className="text-red-400">{l.validation.errorCount} errors</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Validation-issues bij faal */}
          {!result.ok && result.final_validation && result.final_validation.issues.length > 0 && (
            <div className="bg-red-950 border border-red-800 rounded p-4">
              <div className="text-xs uppercase tracking-widest text-red-300 mb-2">Validator-issues (laatste iteratie)</div>
              <ul className="text-xs space-y-1 text-red-200">
                {result.final_validation.issues.map((i, idx) => (
                  <li key={idx} className="font-mono break-all">[{i.rule}] {i.message}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Files-viewer bij success */}
          {result.ok && result.final_package && (
            <div className="space-y-3">
              <FileBlock
                title="manifest.json"
                content={JSON.stringify(result.final_package.manifest, null, 2)}
              />
              <FileBlock
                title="Component.tsx"
                content={result.final_package.componentTsx}
              />
              <div className="text-xs text-gray-500">
                Kopieer beide files naar een lokale pakket-dir en gebruik <code className="text-gray-400">scripts/build-component-archive.mjs</code> voor de sandbox-pipeline. Iteratie 4c.2 automatiseert deze stap.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FileBlock({ title, content }: { title: string; content: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="bg-gray-900 border border-gray-800 rounded">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
        <div className="text-xs uppercase tracking-widest text-gray-500">{title}</div>
        <button
          type="button"
          onClick={copy}
          className="text-xs rounded bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1"
        >
          {copied ? 'Gekopieerd' : 'Kopieer'}
        </button>
      </div>
      <pre className="text-xs font-mono text-gray-200 p-4 overflow-x-auto max-h-96">{content}</pre>
    </div>
  );
}

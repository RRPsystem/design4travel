import type { SectionProps } from './types';

/**
 * Placeholder. `scripts/build-component-archive.mjs` overschrijft dit bestand
 * met de AI-gegenereerde Component.tsx uit een Studio4-pakket, hernoemt het
 * naar `<ComponentName>.tsx` en werkt de import in App.tsx bij.
 *
 * Lokaal (zonder archive-build) toont deze placeholder een neutraal blok
 * zodat vite dev / typecheck werken.
 */
export function GeneratedComponent(_props: SectionProps) {
  return (
    <section className="min-h-screen flex items-center justify-center bg-gray-100 text-gray-500">
      <div className="text-center">
        <div className="text-xs uppercase tracking-widest mb-2">preview-shell</div>
        <div className="font-semibold">Placeholder — wordt vervangen door build-component-archive.</div>
      </div>
    </section>
  );
}

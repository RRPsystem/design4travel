import type { SectionProps } from '@design4/studio4-sdk';

/**
 * Minimale demo-sectie voor de eerste iteratie van de preview-host. Consumeert
 * SectionProps exact zoals een Design4-gegenereerde component dat zal doen:
 *   - brand.name + brand.tagline
 *   - primaryColor voor accent-styling
 *   - pageContent.hello.{title,subtitle,cta} voor content-binding
 *
 * Bewijst dat de mount-flow werkt. Volgende iteratie ondersteunt dynamische
 * loading van een gegenereerd pakket uit Storage.
 */

interface HelloContent {
  title?: string;
  subtitle?: string;
  cta?: string;
}

export function HelloSection({ brand, primaryColor, pageContent }: SectionProps) {
  const hello = (pageContent['hello'] as HelloContent | undefined) ?? {};
  return (
    <section
      className="min-h-screen flex items-center justify-center px-6"
      style={{ backgroundColor: primaryColor }}
    >
      <div className="max-w-2xl text-center text-white">
        <div className="mb-3 inline-block rounded-full bg-white/20 px-3 py-1 text-xs uppercase tracking-widest">
          {brand.tagline || brand.name}
        </div>
        <h1 className="text-5xl md:text-7xl font-black leading-tight drop-shadow">
          {hello.title || 'Preview host'}
        </h1>
        {hello.subtitle && (
          <p className="mt-4 text-lg md:text-xl text-white/90">{hello.subtitle}</p>
        )}
        {hello.cta && (
          <button
            type="button"
            className="mt-8 rounded-full bg-white px-6 py-3 font-semibold shadow-lg hover:brightness-110 transition"
            style={{ color: primaryColor }}
          >
            {hello.cta}
          </button>
        )}
      </div>
    </section>
  );
}

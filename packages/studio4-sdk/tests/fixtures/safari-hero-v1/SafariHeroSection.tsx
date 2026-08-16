import { ArrowDown, Phone } from 'lucide-react';
import { imgHeroResponsive } from '../../../lib/imageUtils';
import type { SectionProps } from './types';

/**
 * SafariHeroSection — voorbeeld Studio4-component-pakket (handmatig geschreven,
 * bewijs dat pakketformaat + validator werken op echte content).
 *
 * Gelaagde safari-hero: full-bleed background, transparante nav via SiteLayout,
 * grote titel links-onderaan, CTA + scroll-hint. Voldoet aan POLICY_V1_0:
 * uitsluitend whitelisted imports, geen verboden runtime-globals, alle images
 * via imgHeroResponsive() met domain-checked URLs (unsplash), named export met
 * filename-match, SectionProps-signature.
 */

interface HeroContent {
  title?: string;
  subtitle?: string;
  ctaLabel?: string;
  heroImage?: string;
  backgroundText?: string;
}

const DEFAULT_HERO_IMAGE =
  'https://images.unsplash.com/photo-1516426122078-c23e76319801';

export function SafariHeroSection({ brand, primaryColor, pageContent }: SectionProps) {
  const hero = (pageContent['hero'] as HeroContent | undefined) ?? {};
  const bg = imgHeroResponsive(hero.heroImage || DEFAULT_HERO_IMAGE);

  return (
    <section
      className="relative w-full min-h-screen overflow-hidden"
      style={{ backgroundColor: '#1a0f08' }}
    >
      <img
        src={bg.src}
        srcSet={bg.srcSet || undefined}
        sizes={bg.sizes}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
      />

      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.20) 0%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.60) 100%)',
        }}
      />

      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <span
          className="select-none font-black tracking-tighter text-white/10 leading-none"
          style={{ fontSize: 'clamp(120px, 22vw, 340px)' }}
        >
          {hero.backgroundText || 'SAFARI'}
        </span>
      </div>

      <div className="absolute left-6 md:left-12 bottom-16 md:bottom-24 z-30 max-w-xl md:max-w-2xl">
        <div
          className="mb-4 inline-block rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-widest text-white"
          style={{ backgroundColor: primaryColor }}
        >
          {brand.tagline || 'Onvergetelijke rondreizen'}
        </div>
        <h1
          className="text-white font-black leading-[0.95] drop-shadow-lg"
          style={{ fontSize: 'clamp(48px, 7vw, 96px)' }}
        >
          {hero.title || 'Safari van je leven'}
        </h1>
        {hero.subtitle && (
          <p className="mt-4 text-white/90 text-lg md:text-xl max-w-lg drop-shadow">
            {hero.subtitle}
          </p>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <a
            href="#offerte"
            className="inline-flex items-center gap-2 rounded-full px-6 py-3 font-semibold text-white shadow-lg hover:brightness-110 transition"
            style={{ backgroundColor: primaryColor }}
          >
            {hero.ctaLabel || 'Vraag offerte aan'}
          </a>
          {brand.phone && (
            <a
              href={`tel:${brand.phone}`}
              className="inline-flex items-center gap-2 rounded-full border border-white/40 px-5 py-3 text-white text-sm hover:bg-white/10 transition"
            >
              <Phone className="h-4 w-4" />
              {brand.phone}
            </a>
          )}
        </div>
      </div>

      <div className="absolute left-1/2 bottom-6 z-30 -translate-x-1/2 flex flex-col items-center gap-1 text-white/80">
        <span className="text-xs tracking-widest uppercase">Scroll</span>
        <ArrowDown className="h-5 w-5 animate-bounce" />
      </div>
    </section>
  );
}

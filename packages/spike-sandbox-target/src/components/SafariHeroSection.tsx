import { ArrowDown, Phone } from 'lucide-react';
import type { SectionProps } from './types';
import { imgHeroResponsive } from './imageUtils';

/**
 * SafariHeroSection — spike-target hero component.
 *
 * Volgt de TravelBridgeAI SectionProps-conventie. Rendert een gelaagd hero:
 * - full-bleed background image
 * - transparante mock-nav bovenaan
 * - grote semi-transparante achtergrondtypografie (soort watermark)
 * - foreground-illustratie rechts
 * - grote titel links-onderaan
 * - CTA + scroll-hint
 *
 * Bewust géén network calls; alle assets zijn inline SVG data-URIs zodat de
 * sandbox tijdens rendering geen externe egress nodig heeft.
 */

// -----------------------------------------------------------------------------
// Inline SVG assets (data-URI) — geen network nodig na build
// -----------------------------------------------------------------------------

const BG_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4c26b"/>
      <stop offset="0.55" stop-color="#e8894a"/>
      <stop offset="1" stop-color="#5a2418"/>
    </linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a1f14"/>
      <stop offset="1" stop-color="#1a0f08"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#sky)"/>
  <circle cx="1180" cy="360" r="110" fill="#fce4a6" opacity="0.9"/>
  <rect y="620" width="1600" height="280" fill="url(#ground)"/>
  <!-- Acacia silhouettes -->
  <g fill="#0f0805" opacity="0.9">
    <path d="M240 640 L240 460 Q220 430 260 420 Q280 415 300 430 Q340 410 380 430 Q420 415 440 440 Q460 430 480 460 L480 640 Z"/>
    <path d="M1250 660 L1250 500 Q1230 470 1270 460 Q1290 455 1310 470 Q1350 450 1390 470 Q1420 465 1440 490 L1440 660 Z"/>
    <path d="M760 700 L780 560 L800 700 Z"/>
    <path d="M900 690 L920 570 L940 690 Z"/>
  </g>
</svg>
`)}`;

const LION_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500">
  <g fill="#2b160b" stroke="#0f0805" stroke-width="2">
    <ellipse cx="200" cy="220" rx="130" ry="115"/>
    <circle cx="200" cy="230" r="80" fill="#8a4a24"/>
    <circle cx="175" cy="220" r="6" fill="#fce4a6"/>
    <circle cx="225" cy="220" r="6" fill="#fce4a6"/>
    <path d="M195 250 Q200 260 205 250 Z" fill="#0f0805"/>
    <ellipse cx="200" cy="400" rx="90" ry="80"/>
  </g>
</svg>
`)}`;

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

interface HeroContent {
  title?: string;
  subtitle?: string;
  backgroundText?: string;
  ctaLabel?: string;
  heroImage?: string;
  foregroundImage?: string;
}

export function SafariHeroSection({ brand, primaryColor, pageContent }: SectionProps) {
  const hero = (pageContent?.['hero'] as HeroContent | undefined) ?? {};
  const bgImage = imgHeroResponsive(hero.heroImage || BG_SVG);
  const foreground = hero.foregroundImage || LION_SVG;

  return (
    <section
      className="relative w-full min-h-screen overflow-hidden"
      style={{ backgroundColor: '#1a0f08' }}
    >
      {/* Full-bleed background */}
      <img
        src={bgImage.src}
        srcSet={bgImage.srcSet || undefined}
        sizes={bgImage.sizes}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
      />

      {/* Warm overlay om tekst leesbaar te maken */}
      <div
        className="absolute inset-0"
        style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.55) 100%)' }}
      />

      {/* Transparante mock-nav */}
      <header className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-6 md:px-12 py-5">
        <div className="flex items-center gap-3">
          <div
            className="h-9 w-9 rounded-full grid place-items-center text-white font-bold text-sm"
            style={{ backgroundColor: primaryColor }}
          >
            {brand.name.slice(0, 1)}
          </div>
          <span className="text-white font-semibold tracking-wide">{brand.name}</span>
        </div>
        <nav className="hidden md:flex items-center gap-8 text-white/90 text-sm font-medium">
          <a href="#reizen">Reizen</a>
          <a href="#bestemmingen">Bestemmingen</a>
          <a href="#over">Over ons</a>
          <a href="#contact">Contact</a>
        </nav>
        {brand.phone && (
          <a
            href={`tel:${brand.phone}`}
            className="hidden md:inline-flex items-center gap-2 rounded-full border border-white/40 px-4 py-2 text-white text-sm hover:bg-white/10 transition"
          >
            <Phone className="h-4 w-4" />
            {brand.phone}
          </a>
        )}
      </header>

      {/* Grote semi-transparante achtergrondtypografie */}
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <span
          className="select-none font-black tracking-tighter text-white/10 leading-none"
          style={{ fontSize: 'clamp(120px, 22vw, 340px)' }}
        >
          {hero.backgroundText || 'SAFARI'}
        </span>
      </div>

      {/* Foreground cutout rechts (desktop) */}
      <img
        src={foreground}
        alt=""
        className="hidden md:block absolute right-4 lg:right-16 bottom-0 z-20 h-[70vh] w-auto object-contain"
      />

      {/* Titel links-onderaan */}
      <div className="absolute left-6 md:left-12 bottom-16 md:bottom-24 z-30 max-w-xl md:max-w-2xl">
        <div
          className="mb-4 inline-block rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-widest"
          style={{ backgroundColor: primaryColor, color: '#fff' }}
        >
          {brand.tagline || 'Onvergetelijke rondreizen'}
        </div>
        <h1 className="text-white font-black leading-[0.95] drop-shadow-lg" style={{ fontSize: 'clamp(48px, 7vw, 96px)' }}>
          {hero.title || 'Safari van je leven'}
        </h1>
        {hero.subtitle && (
          <p className="mt-4 text-white/90 text-lg md:text-xl max-w-lg drop-shadow">
            {hero.subtitle}
          </p>
        )}
        <div className="mt-6 flex items-center gap-4">
          <a
            href="#offerte"
            className="inline-flex items-center gap-2 rounded-full px-6 py-3 font-semibold text-white shadow-lg hover:brightness-110 transition"
            style={{ backgroundColor: primaryColor }}
          >
            {hero.ctaLabel || 'Vraag offerte aan'}
          </a>
        </div>
      </div>

      {/* Scroll hint */}
      <div className="absolute left-1/2 bottom-6 z-30 -translate-x-1/2 flex flex-col items-center gap-1 text-white/80">
        <span className="text-xs tracking-widest uppercase">Scroll</span>
        <ArrowDown className="h-5 w-5 animate-bounce" />
      </div>
    </section>
  );
}

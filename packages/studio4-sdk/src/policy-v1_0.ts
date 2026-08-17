import type { SdkPolicy } from './types.js';

/**
 * Studio4 Component SDK — Policy v1.0.
 *
 * SERVER-CONTROLLED. Versie-gebonden aan `sdkVersion: '1.0'` in de manifest.
 * AI-declaraties in `manifest.requestedImports` etc. worden HIER tegenaan
 * gevalideerd. AI mag zijn eigen beveiligingsbeleid NIET beïnvloeden.
 *
 * Elke wijziging aan deze policy = nieuwe SDK-versie (v1.1, v2.0, etc.), zodat
 * eerder gegenereerde componenten met een expliciete `sdkVersion`-pin blijven
 * werken tegen de bijbehorende policy.
 *
 * Basis: baseline-inventarisatie van TravelBridgeAI main (2026-08-15) —
 * zie `docs/travelbridgeai/baseline-2026-08-15.md`.
 */

export const POLICY_V1_0: SdkPolicy = {
  version: '1.0',

  /**
   * Whitelisted imports. Alles daarbuiten → validator-error.
   * Uitbreiden = nieuwe SDK-versie, niet ad-hoc.
   */
  allowedImports: [
    // React & runtime
    'react',
    'react/jsx-runtime',

    // i18n (optioneel; als component tekst-labels nodig heeft)
    'react-i18next',

    // Icons (TravelBridgeAI's standaard-icoonset)
    'lucide-react',

    // TravelBridgeAI-locale helpers waar Design4-componenten in landen:
    // - imageUtils: verplicht voor responsive images (netlify-image-CDN)
    // - sectionStyle: mergeSectionRoot() voor brand-override-styling
    // - types: SectionProps + BrandData
    '../../../lib/imageUtils',
    '../../../lib/sectionStyle',
    './types',
  ] as const,

  /**
   * Runtime-globals die de component NIET direct mag gebruiken. Validator
   * doet identifier-scan op de gegenereerde TSX en weigert bare-uses.
   */
  forbiddenGlobals: [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'eval',
    'Function',
  ] as const,

  /**
   * Browser-only globals die WEL gebruikt mogen worden, mits gated met een
   * SSR-safe guard (`typeof window !== 'undefined'` of binnen `useEffect`).
   * TravelBridgeAI zelf gebruikt dit patroon in HeroSection voor LCP-detectie.
   */
  requiresSsrGuard: ['window', 'document', 'navigator', 'location'] as const,

  /**
   * Image-domeinen die TravelBridgeAI's Netlify-image-CDN accepteert. Bron:
   * `netlify.toml` [images].remote_images. Elke `<img src="...">` of
   * `imgHeroResponsive("...")`-URL moet hierbinnen vallen; anders reject.
   *
   * NB: images.unsplash.com + images.pexels.com zijn hier bewust NIET
   * whitelisted. AI moet stock-photos via {{image:role|query}}-tokens
   * aanvragen; Design4-backend (media-search Edge Function) vervangt die
   * tokens na validatie door bestaande URLs uit die domeinen. Zonder deze
   * indirection genereert AI vaak niet-bestaande photo-IDs → 404's.
   */
  allowedImageDomains: [
    'supabase.co',
    'tr2storage.blob.core.windows.net',
    'online.travelcompositor.com',
    'res.cloudinary.com',
    'static.travelconline.com',
    'i.travelapi.com',
  ] as const,

  componentContract: {
    exportKind: 'named',
    exportNameMustMatchFileName: true,
    propsInterface: 'SectionProps',
    returnType: 'ReactElement | null',
    hooksBeforeEarlyReturn: true,
  },

  stylingContract: {
    system: 'tailwind-3.4-standard',
    disallowedInlineFeatures: [
      // Arbitrary Tailwind-classes met url() zijn een injectie-vector.
      'tailwind-arbitrary-url',
      // @apply in inline <style> is niet toegestaan; alleen classes of style-attribute.
      'apply-in-inline-style',
    ] as const,
  },

  imageContract: {
    /** Design4-componenten MOETEN deze helpers gebruiken voor image-URLs. */
    mustUseHelpers: [
      'imgHeroResponsive',
      'imgCardResponsive',
      'imgHero',
      'imgCard',
      'imgDetail',
      'imgDestCard',
      'optimizeImageUrl',
    ] as const,
    forbidUnwhitelistedDomains: true,
    requireSrcSetSizes: true,
  },

  pageIntegrationHints: {
    /**
     * `transparentNav` is een SiteLayout-prop, niet section-level. Manifest
     * mag `requiresTransparentNav: true` aanvragen — reviewer moet de sectie
     * dan op een pagina plaatsen waar `transparentNav={true}` is gezet.
     */
    transparentNav: 'requires-page-level',
    /**
     * Hero-secties mogen een `<meta name="initial-hero-image" content="...">`
     * suggereren voor LCP-preload; TravelBridgeAI's SiteRenderer verzorgt de
     * daadwerkelijke <link rel="preload">.
     */
    seoLcpPreload: 'may-suggest-meta-seed',
  },
} as const;

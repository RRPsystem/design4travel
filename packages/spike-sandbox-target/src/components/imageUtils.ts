/**
 * Minimale spike-versie van TravelBridgeAI's imageUtils.
 * Doet geen echte optimization; returnt URLs pass-through en biedt dezelfde
 * ResponsiveImage-shape zodat SafariHeroSection identiek werkt aan een echte
 * TravelBridgeAI-sectie.
 */

export interface ResponsiveImage {
  src: string;
  srcSet: string;
  sizes: string;
}

export function optimizeImageUrl(url: string | null | undefined, _w = 800, _q = 75): string {
  return url || '';
}

export function imgHeroResponsive(url?: string | null): ResponsiveImage {
  return {
    src: url || '',
    srcSet: '',
    sizes: '(max-width: 900px) 100vw, 1600px',
  };
}

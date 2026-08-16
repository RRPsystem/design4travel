/**
 * Preview-shell versie van TravelBridgeAI's imageUtils. Pass-through op
 * de URL (geen echte Netlify Image CDN in de sandbox). Signature blijft
 * gelijk zodat AI-gegenereerde componenten die
 *   `import { imgHeroResponsive } from '../../lib/imageUtils';`
 * gebruiken netjes werken.
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

export function imgCardResponsive(url?: string | null, sizes?: string): ResponsiveImage {
  return {
    src: url || '',
    srcSet: '',
    sizes: sizes || '(min-width: 768px) 400px, 100vw',
  };
}

export const imgHero = (url?: string | null) => optimizeImageUrl(url, 1600, 82);
export const imgCard = (url?: string | null) => optimizeImageUrl(url, 400, 75);
export const imgDetail = (url?: string | null) => optimizeImageUrl(url, 900, 80);
export const imgDestCard = (url?: string | null) => optimizeImageUrl(url, 600, 75);

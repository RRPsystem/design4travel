import type { CSSProperties } from 'react';

/**
 * BoxStyle → CSSProperties mapping.
 *
 * Bewust NIET generiek — we accepteren alleen de subset velden die het
 * BoxStyleSchema in @design4/typed-nodes exposeert. Onbekende keys worden
 * genegeerd. Zo blijft de renderer beveiligd tegen "raw CSS" die zich als
 * BoxStyle vermomd zou hebben (Zod moet dat al vangen, maar defence-in-depth).
 */

// Spacing tokens → pixels (moet 1:1 kloppen met BoxStyleSchema-tokens).
const SPACING_TOKENS: Record<string, number> = {
  none: 0, xs: 4, sm: 8, md: 16, lg: 24, xl: 32, '2xl': 48, '3xl': 64,
};

export function spacingToPx(v: unknown): number | undefined {
  if (typeof v === 'number' && v >= 0) return v;
  if (typeof v === 'string' && v in SPACING_TOKENS) return SPACING_TOKENS[v];
  return undefined;
}

// Shadow-presets → CSS box-shadow strings.
const SHADOW_PRESETS: Record<string, string | undefined> = {
  none: undefined,
  subtle: '0 1px 2px rgba(15,23,42,0.06), 0 1px 3px rgba(15,23,42,0.08)',
  medium: '0 4px 8px rgba(15,23,42,0.08), 0 8px 16px rgba(15,23,42,0.10)',
  strong: '0 12px 24px rgba(15,23,42,0.12), 0 24px 48px rgba(15,23,42,0.18)',
};

export function shadowPresetToCss(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return SHADOW_PRESETS[v];
}

interface BorderSide { width?: number; color?: string; style?: string }
function borderSideToCss(s: BorderSide | undefined): string | undefined {
  if (!s) return undefined;
  const w = typeof s.width === 'number' ? `${s.width}px` : '1px';
  const c = typeof s.color === 'string' ? s.color : '#e5e7eb';
  const st = typeof s.style === 'string' ? s.style : 'solid';
  return `${w} ${st} ${c}`;
}

function toBox(v: unknown): { top?: unknown; right?: unknown; bottom?: unknown; left?: unknown } {
  if (v == null) return {};
  if (typeof v === 'number' || typeof v === 'string') return { top: v, right: v, bottom: v, left: v };
  if (typeof v === 'object') {
    const o = v as { top?: unknown; right?: unknown; bottom?: unknown; left?: unknown };
    return { top: o.top, right: o.right, bottom: o.bottom, left: o.left };
  }
  return {};
}

/**
 * Map een BoxStyle (via Zod-validated) naar CSSProperties. Onbekende
 * velden worden genegeerd. Returns een MERGEABLE style-object.
 */
export function boxStyleToCss(box: unknown): CSSProperties {
  if (!box || typeof box !== 'object') return {};
  const s = box as Record<string, unknown>;
  const out: CSSProperties = {};

  // Background
  const bg = s.background as Record<string, unknown> | undefined;
  if (bg && typeof bg === 'object') {
    if (typeof bg.color === 'string') out.backgroundColor = bg.color;
    // Gradient overrides solid color if both set
    const grad = bg.gradient as { from?: string; to?: string; angle?: number } | undefined;
    if (grad && typeof grad === 'object' && typeof grad.from === 'string' && typeof grad.to === 'string') {
      const angle = typeof grad.angle === 'number' ? grad.angle : 180;
      out.backgroundImage = `linear-gradient(${angle}deg, ${grad.from}, ${grad.to})`;
    } else if (typeof bg.image === 'string') {
      out.backgroundImage = `url(${bg.image})`;
    }
    if (typeof bg.size === 'string') out.backgroundSize = bg.size;
    if (typeof bg.position === 'string') {
      // Enum has 'top-left' etc; CSS accepts 'top left'
      out.backgroundPosition = bg.position.replace('-', ' ');
    }
    if (typeof bg.repeat === 'string') out.backgroundRepeat = bg.repeat;
  }

  // Border — 'all' shorthand then per-side overrides.
  const border = s.border as Record<string, unknown> | undefined;
  if (border && typeof border === 'object') {
    const allCss = borderSideToCss(border.all as BorderSide | undefined);
    if (allCss) out.border = allCss;
    const t = borderSideToCss(border.top as BorderSide | undefined);
    const r = borderSideToCss(border.right as BorderSide | undefined);
    const b = borderSideToCss(border.bottom as BorderSide | undefined);
    const l = borderSideToCss(border.left as BorderSide | undefined);
    if (t) out.borderTop = t;
    if (r) out.borderRight = r;
    if (b) out.borderBottom = b;
    if (l) out.borderLeft = l;
  }

  // Radius — number OR per-hoek object.
  const radius = s.radius;
  if (typeof radius === 'number') {
    out.borderRadius = radius;
  } else if (radius && typeof radius === 'object') {
    const rr = radius as {
      topLeft?: number; topRight?: number; bottomRight?: number; bottomLeft?: number;
    };
    // CSS shorthand order: TL TR BR BL
    const tl = typeof rr.topLeft === 'number' ? rr.topLeft : 0;
    const tr = typeof rr.topRight === 'number' ? rr.topRight : 0;
    const br = typeof rr.bottomRight === 'number' ? rr.bottomRight : 0;
    const bl = typeof rr.bottomLeft === 'number' ? rr.bottomLeft : 0;
    out.borderRadius = `${tl}px ${tr}px ${br}px ${bl}px`;
  }

  // Shadow
  const sh = shadowPresetToCss(s.shadow);
  if (sh) out.boxShadow = sh;

  // Opacity
  if (typeof s.opacity === 'number') out.opacity = s.opacity;

  // Padding + margin (single OR per-side objects).
  const pad = toBox(s.padding);
  const padTop = spacingToPx(pad.top);
  const padRight = spacingToPx(pad.right);
  const padBottom = spacingToPx(pad.bottom);
  const padLeft = spacingToPx(pad.left);
  if (padTop !== undefined) out.paddingTop = padTop;
  if (padRight !== undefined) out.paddingRight = padRight;
  if (padBottom !== undefined) out.paddingBottom = padBottom;
  if (padLeft !== undefined) out.paddingLeft = padLeft;

  const mar = toBox(s.margin);
  const marTop = spacingToPx(mar.top);
  const marRight = spacingToPx(mar.right);
  const marBottom = spacingToPx(mar.bottom);
  const marLeft = spacingToPx(mar.left);
  if (marTop !== undefined) out.marginTop = marTop;
  if (marRight !== undefined) out.marginRight = marRight;
  if (marBottom !== undefined) out.marginBottom = marBottom;
  if (marLeft !== undefined) out.marginLeft = marLeft;

  // Sizing bounds
  if (typeof s.minHeight === 'number') out.minHeight = s.minHeight;
  if (typeof s.minWidth === 'number') out.minWidth = s.minWidth;
  if (typeof s.maxWidth === 'number') out.maxWidth = s.maxWidth;

  return out;
}

/**
 * Map maskPreset (image-prop) naar borderRadius CSS. Returns partial
 * CSSProperties. Bij 'none' → leeg object (respecteer explicit style.radius).
 */
export function maskPresetToCss(preset: unknown, width?: number, height?: number): CSSProperties {
  if (typeof preset !== 'string' || preset === 'none') return {};
  const shortSide = Math.min(width ?? 200, height ?? 200);
  switch (preset) {
    case 'circle':
      return { borderRadius: '50%' };
    case 'pill':
      return { borderRadius: shortSide };
    case 'rounded':
      return { borderRadius: 16 };
    case 'arch':
      return { borderRadius: `${shortSide}px ${shortSide}px 0 0` };
    case 'half-rounded-right':
      return { borderRadius: `0 999px 999px 0` };
    case 'half-rounded-left':
      return { borderRadius: `999px 0 0 999px` };
    default:
      return {};
  }
}

/**
 * Map aspect-ratio-enum naar CSS `aspect-ratio` string.
 */
export function aspectRatioToCss(v: unknown): string | undefined {
  if (typeof v !== 'string' || v === 'auto') return undefined;
  // 16:9 → '16 / 9'
  const parts = v.split(':');
  if (parts.length !== 2) return undefined;
  const [a, b] = parts;
  if (!a || !b) return undefined;
  return `${a} / ${b}`;
}

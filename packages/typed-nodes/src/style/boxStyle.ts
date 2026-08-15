import { z } from 'zod';

/**
 * Gedeelde style-primitives voor alle nodes die visuele styling ondersteunen.
 *
 * Ontwerpprincipes:
 * 1. **Één canonical `BoxStyleSchema` per node** — background/border/radius/
 *    shadow/opacity/margin/padding gebruiken dezelfde vorm ongeacht node-
 *    type. Dat maakt DesignDoc voorspelbaar, tools consistent en toekomstige
 *    renderers (PDF/DOCX/image) hebben één schema om tegen te programmeren.
 *
 * 2. **Theme-token OF veilig gevalideerde waarde** — kleuren moeten óf een
 *    `{brand.xxx}`-referentie zijn, óf een hex (`#RGB`/`#RRGGBB`/`#RRGGBBAA`),
 *    óf een gevalideerde `rgb(a)/hsl(a)`-string, óf een van een korte
 *    whitelist named-colors. Raw CSS zoals `url(...)`, `expression(...)`,
 *    of willekeurige strings worden Zod-afgewezen. Zo blijft exacte
 *    merkkleur mogelijk zonder XSS-risico.
 *
 * 3. **Spacing via numeriek OF gecontroleerd token** — pixel-waarden zijn
 *    toegestaan (bounded) maar tokens (`xs`/`sm`/`md`/`lg`/`xl`/`2xl`/`3xl`)
 *    zijn de voorkeur. Renderer mapt tokens naar concrete px.
 *
 * 4. **Border-radius single OF per-hoek** — zo kan Claude ook "half rond"-
 *    scenarios modelleren zonder een aparte mask-node.
 *
 * 5. **Shadow als preset**, geen custom CSS. Vermijdt uiteenlopende designs.
 *
 * 6. **Renderer-neutraal** — de style-props zijn abstract genoeg dat een
 *    PDF/DOCX/image-renderer ze gecontroleerd kan mappen of gecontroleerd
 *    laten vallen (bv. DOCX skipt shadow maar behoudt background-color).
 */

// -----------------------------------------------------------------------------
// Color
// -----------------------------------------------------------------------------

/**
 * Kleur: hex, brand-token-reference, rgb(a)/hsl(a), of whitelisted named color.
 * Raw CSS-strings zoals url()/expression()/attr() worden geweigerd.
 */
export const ColorValueSchema = z.string().refine(
  (v) => {
    const s = v.trim();
    if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return true;
    if (/^\{[a-zA-Z0-9._-]{1,60}\}$/.test(s)) return true;
    if (/^rgba?\(\s*(?:\d{1,3}\s*,\s*){2}\d{1,3}(\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(s)) return true;
    if (/^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(s)) return true;
    const named = new Set(['transparent', 'currentcolor', 'inherit', 'white', 'black']);
    if (named.has(s.toLowerCase())) return true;
    return false;
  },
  {
    message:
      'color must be hex (#RGB/#RRGGBB/#RRGGBBAA), a {brand.token}, rgb(a)/hsl(a) with valid channels, or a whitelisted named color',
  },
);
export type ColorValue = z.infer<typeof ColorValueSchema>;

// -----------------------------------------------------------------------------
// Spacing
// -----------------------------------------------------------------------------

/**
 * Named spacing-tokens. Renderer mapt naar concrete pixels via een centraal
 * theme (voor MVP: xs=4, sm=8, md=16, lg=24, xl=32, 2xl=48, 3xl=64).
 */
export const SpacingTokenSchema = z.enum([
  'none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl',
]);
export type SpacingToken = z.infer<typeof SpacingTokenSchema>;

/** Spacing = numeriek px OF een named token. */
export const SpacingValueSchema = z.union([
  z.number().min(0).max(400),
  SpacingTokenSchema,
]);
export type SpacingValue = z.infer<typeof SpacingValueSchema>;

/** Padding/margin: single OF per zijde. */
export const SpacingBoxSchema = z.union([
  SpacingValueSchema,
  z.object({
    top: SpacingValueSchema.optional(),
    right: SpacingValueSchema.optional(),
    bottom: SpacingValueSchema.optional(),
    left: SpacingValueSchema.optional(),
  }),
]);
export type SpacingBox = z.infer<typeof SpacingBoxSchema>;

// -----------------------------------------------------------------------------
// Background
// -----------------------------------------------------------------------------

/**
 * Background — solid color, image, of gradient. Gradient blijft in PR-A
 * beperkt tot een gecontroleerd 2-stop lineair-gradient-token; complexere
 * gradient-syntax volgt in PR-B.
 */
export const GradientSchema = z.object({
  from: ColorValueSchema,
  to: ColorValueSchema,
  angle: z.number().min(0).max(360).default(180),
});
export type Gradient = z.infer<typeof GradientSchema>;

export const BackgroundSchema = z.object({
  color: ColorValueSchema.optional(),
  image: z.string().url().optional(),
  gradient: GradientSchema.optional(),
  size: z.enum(['cover', 'contain', 'auto']).default('cover'),
  position: z.enum([
    'center', 'top', 'bottom', 'left', 'right',
    'top-left', 'top-right', 'bottom-left', 'bottom-right',
  ]).default('center'),
  repeat: z.enum(['no-repeat', 'repeat']).default('no-repeat'),
});
export type Background = z.infer<typeof BackgroundSchema>;

// -----------------------------------------------------------------------------
// Border
// -----------------------------------------------------------------------------

export const BorderStyleSchema = z.enum(['solid', 'dashed', 'dotted']);

export const BorderSideSchema = z.object({
  width: z.number().min(0).max(20).default(1),
  color: ColorValueSchema.default('#e5e7eb'),
  style: BorderStyleSchema.default('solid'),
});
export type BorderSide = z.infer<typeof BorderSideSchema>;

/**
 * Border: `all` shorthand OF per-side. Per-side wint van all als beide zijn
 * gezet (renderer merged). Alleen expliciet gezette sides worden gerenderd.
 */
export const BorderSchema = z.object({
  all: BorderSideSchema.optional(),
  top: BorderSideSchema.optional(),
  right: BorderSideSchema.optional(),
  bottom: BorderSideSchema.optional(),
  left: BorderSideSchema.optional(),
});
export type Border = z.infer<typeof BorderSchema>;

// -----------------------------------------------------------------------------
// Radius
// -----------------------------------------------------------------------------

/**
 * Radius: number (alle hoeken gelijk) OF object per hoek. Voor "half rond
 * rechts" bv. `{topLeft: 0, topRight: 999, bottomRight: 999, bottomLeft: 0}`.
 */
export const RadiusSchema = z.union([
  z.number().min(0).max(9999),
  z.object({
    topLeft: z.number().min(0).max(9999).optional(),
    topRight: z.number().min(0).max(9999).optional(),
    bottomRight: z.number().min(0).max(9999).optional(),
    bottomLeft: z.number().min(0).max(9999).optional(),
  }),
]);
export type Radius = z.infer<typeof RadiusSchema>;

// -----------------------------------------------------------------------------
// Shadow
// -----------------------------------------------------------------------------

/** Shadow als preset — geen custom CSS-strings. */
export const ShadowPresetSchema = z.enum(['none', 'subtle', 'medium', 'strong']);
export type ShadowPreset = z.infer<typeof ShadowPresetSchema>;

// -----------------------------------------------------------------------------
// BoxStyle
// -----------------------------------------------------------------------------

export const BoxStyleSchema = z.object({
  background: BackgroundSchema.optional(),
  border: BorderSchema.optional(),
  radius: RadiusSchema.optional(),
  shadow: ShadowPresetSchema.optional(),
  opacity: z.number().min(0).max(1).optional(),
  padding: SpacingBoxSchema.optional(),
  margin: SpacingBoxSchema.optional(),
  minHeight: z.number().min(0).max(4000).optional(),
  minWidth: z.number().min(0).max(4000).optional(),
  maxWidth: z.number().min(0).max(4000).optional(),
});
export type BoxStyle = z.infer<typeof BoxStyleSchema>;

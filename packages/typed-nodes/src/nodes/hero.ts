import { z } from 'zod';
import type { NodeDefinition } from '../types.js';
import { BoxStyleSchema, ColorValueSchema } from '../style/boxStyle.js';
import { TextAlignSchema } from '../style/align.js';

/**
 * Hero — prominente header met achtergrondafbeelding, titel, subtitle en
 * een gecontroleerde overlay-laag voor leesbaarheid.
 *
 * Overlay: `overlayColor` + `overlayOpacity` (0..1). Voor "donkere trans-
 * parante overlay over de hero-afbeelding": color=#000000, opacity=0.5.
 * Legacy `overlay: boolean` blijft bestaan voor backward-compat — bij
 * `true` wordt een default zwart-gradient gebruikt als er geen expliciete
 * overlayColor/Opacity is gezet.
 *
 * Rendering per output:
 * - web:   full support (backgroundImage + overlay-div + centered content).
 * - pdf:   background-image + solid overlay-tint (fallback color).
 * - image: full support.
 * - docx:  reduce naar heading + subtitle als plain paragraphs; image
 *          wordt embed'd zonder overlay.
 */
export const HeroPropsSchema = z.object({
  title: z.string().default('Ontdek jouw volgende reis'),
  subtitle: z.string().default('Verhalen, tips en ontwerpen voor onvergetelijke reizen.'),
  imageSrc: z.string().url().default('https://placehold.co/1600x600?text=Hero'),
  imageAlt: z.string().default(''),
  /** Legacy — bij `true` gebruikt renderer default overlayColor/Opacity als
   *  die niet expliciet zijn gezet. Verkies overlayColor + overlayOpacity. */
  overlay: z.boolean().default(true),
  overlayColor: ColorValueSchema.optional(),
  overlayOpacity: z.number().min(0).max(1).optional(),
  height: z.number().min(200).max(1200).default(520),
  align: TextAlignSchema.default('center'),
  titleColor: ColorValueSchema.default('#ffffff'),
  subtitleColor: ColorValueSchema.default('#f5f5f5'),
  titleFontSize: z.number().min(16).max(200).default(56),
  /** Additionele visuele styling (border/radius voor rounded-hero-cards). */
  style: BoxStyleSchema.optional(),
});
export type HeroProps = z.infer<typeof HeroPropsSchema>;

export const heroNode: NodeDefinition = {
  type: 'hero',
  label: 'Hero',
  source: 'builtin',
  propsSchema: HeroPropsSchema,
  bindSlots: [
    { key: 'title', label: 'Titel', expects: 'string' },
    { key: 'subtitle', label: 'Ondertitel', expects: 'string' },
    { key: 'imageSrc', label: 'Achtergrondafbeelding', expects: 'image' },
  ],
  acceptsChildren: false,
};

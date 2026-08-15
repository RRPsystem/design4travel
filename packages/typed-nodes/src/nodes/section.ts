import { z } from 'zod';
import type { NodeDefinition } from '../types.js';
import { BoxStyleSchema, ColorValueSchema } from '../style/boxStyle.js';

/**
 * Section — semantische container met full-bleed background + geconstrainde
 * inner content-breedte. De section zelf is 100% breed; child-content wordt
 * gecentreerd op `maxContentWidth`.
 *
 * Achtergrond gaat via `style.background` (color / image / gradient). Overlay
 * (semi-transparante laag óver de background) heeft eigen props omdat het
 * conceptueel bij de section hoort, niet bij algemene box-styling.
 *
 * Rendering per output:
 * - web:   full support (background + overlay + geconstrainde inner).
 * - pdf:   full support behalve gradient (fallback naar solid `background.color`).
 * - image: full support (statische snapshot).
 * - docx:  reduceert naar plain paragraph + optionele background-shading;
 *          overlay en gradient worden gedropt, content blijft.
 */
export const SectionPropsSchema = z.object({
  paddingY: z.number().min(0).default(48),
  paddingX: z.number().min(0).default(24),
  gap: z.number().min(0).default(24),
  align: z.enum(['start', 'center', 'end', 'stretch']).default('stretch'),
  maxContentWidth: z.number().min(320).default(1200),
  /** Overlay-kleur bovenop background — voor "dark overlay over hero-image". */
  overlayColor: ColorValueSchema.optional(),
  overlayOpacity: z.number().min(0).max(1).default(0),
  /** Alle andere visuele styling (background/border/radius/shadow/opacity). */
  style: BoxStyleSchema.optional(),
});
export type SectionProps = z.infer<typeof SectionPropsSchema>;

export const sectionNode: NodeDefinition = {
  type: 'section',
  label: 'Sectie',
  source: 'builtin',
  propsSchema: SectionPropsSchema,
  bindSlots: [],
  acceptsChildren: true,
};

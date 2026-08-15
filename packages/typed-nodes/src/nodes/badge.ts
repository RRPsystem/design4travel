import { z } from 'zod';
import type { NodeDefinition } from '../types.js';
import { BoxStyleSchema, ColorValueSchema } from '../style/boxStyle.js';

/**
 * Badge — compacte label/pill voor status, categorie, prijs-indicatie etc.
 * Nooit klikbaar (voor klikbaar: gebruik `button`). Voor "offertenummer
 * bovenaan" is een badge een lichte, statische indicatie.
 *
 * Rendering per output: identiek aan span in alle targets.
 */
export const BadgePropsSchema = z.object({
  text: z.string().default('Badge'),
  color: ColorValueSchema.optional(),
  textColor: ColorValueSchema.optional(),
  variant: z.enum(['solid', 'subtle', 'outline']).default('subtle'),
  size: z.enum(['xs', 'sm', 'md']).default('sm'),
  uppercase: z.boolean().default(false),
  /** Additionele visuele styling (radius/border/margin/etc.). */
  style: BoxStyleSchema.optional(),
});
export type BadgeProps = z.infer<typeof BadgePropsSchema>;

export const badgeNode: NodeDefinition = {
  type: 'badge',
  label: 'Badge',
  source: 'builtin',
  propsSchema: BadgePropsSchema,
  bindSlots: [{ key: 'text', label: 'Tekst', expects: 'string' }],
  acceptsChildren: false,
};

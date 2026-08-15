import { z } from 'zod';
import type { NodeDefinition } from '../types.js';
import { ColorValueSchema } from '../style/boxStyle.js';

/**
 * Divider — visuele scheidingslijn, horizontaal of verticaal. Voor "dun
 * gouden streepje van 80 pixels onder de titel" is dit de primitive:
 *   `<divider orientation="horizontal" length={80} thickness={2}
 *             color="#d4af37" style="solid" align="start" />`.
 *
 * Bewust GEEN full BoxStyle — dit is een simpel primitief met eigen
 * shape-props. `spacing` doet de rol van margin.
 *
 * Rendering per output:
 * - web:   div met borderTop of borderLeft.
 * - pdf:   getekende lijn.
 * - image: getekende lijn.
 * - docx:  <w:hr> equivalent voor horizontaal; verticaal gedropt.
 */
export const DividerPropsSchema = z.object({
  orientation: z.enum(['horizontal', 'vertical']).default('horizontal'),
  /** Lengte in px. `undefined` = 100% van parent-cross-axis. */
  length: z.number().min(1).max(4000).optional(),
  thickness: z.number().min(1).max(20).default(1),
  color: ColorValueSchema.default('#e5e7eb'),
  style: z.enum(['solid', 'dashed', 'dotted']).default('solid'),
  align: z.enum(['start', 'center', 'end']).default('start'),
  /** Marge boven+onder (horizontaal) of links+rechts (verticaal), in px. */
  spacing: z.number().min(0).max(200).default(0),
});
export type DividerProps = z.infer<typeof DividerPropsSchema>;

export const dividerNode: NodeDefinition = {
  type: 'divider',
  label: 'Scheidingslijn',
  source: 'builtin',
  propsSchema: DividerPropsSchema,
  bindSlots: [],
  acceptsChildren: false,
};

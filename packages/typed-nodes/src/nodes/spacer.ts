import { z } from 'zod';
import type { NodeDefinition } from '../types.js';

/**
 * Spacer — lege ruimte om afstand te creëren zonder marges op omliggende
 * nodes te wijzigen.
 *
 * **BEWUST BEPERKT.** Verkies `gap` (op parent-container) en `padding`
 * (op section) boven spacer-nodes waar mogelijk — dat is responsief en
 * consistent. Gebruik spacer alleen voor genuine visuele adempauzes waar
 * container-props niet passen (bv. asymmetric spacing tussen 2 specifieke
 * children in een layout-row).
 *
 * Rendering per output:
 * - web:   div met height/width.
 * - pdf:   idem (fixed sizing).
 * - image: idem.
 * - docx:  paragraph-with-height-only.
 */
export const SpacerPropsSchema = z.object({
  /** Bij parent=layout-column: height. Bij parent=layout-row: width. */
  size: z.number().min(0).max(400).default(24),
  /** Optioneel forceer as ongeacht parent. */
  axis: z.enum(['vertical', 'horizontal', 'auto']).default('auto'),
});
export type SpacerProps = z.infer<typeof SpacerPropsSchema>;

export const spacerNode: NodeDefinition = {
  type: 'spacer',
  label: 'Ruimte',
  source: 'builtin',
  propsSchema: SpacerPropsSchema,
  bindSlots: [],
  acceptsChildren: false,
};

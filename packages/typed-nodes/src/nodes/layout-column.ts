import { z } from 'zod';
import type { NodeDefinition } from '../types.js';

import { BoxStyleSchema } from '../style/boxStyle.js';

export const LayoutColumnPropsSchema = z.object({
  gap: z.number().min(0).default(24),
  align: z.enum(['start', 'center', 'end', 'stretch']).default('stretch'),
  padding: z.number().min(0).default(0),
  maxWidth: z.number().min(0).optional(),
  /** Gedeelde visuele styling: background / border / radius / shadow / opacity /
   *  margin. Zie packages/typed-nodes/src/style/boxStyle.ts. */
  style: BoxStyleSchema.optional(),
});
export type LayoutColumnProps = z.infer<typeof LayoutColumnPropsSchema>;

export const layoutColumnNode: NodeDefinition = {
  type: 'layout-column',
  label: 'Kolom',
  source: 'builtin',
  propsSchema: LayoutColumnPropsSchema,
  bindSlots: [],
  acceptsChildren: true,
};

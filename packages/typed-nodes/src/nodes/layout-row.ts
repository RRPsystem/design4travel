import { z } from 'zod';
import type { NodeDefinition } from '../types.js';

export const LayoutRowPropsSchema = z.object({
  gap: z.number().min(0).default(16),
  align: z.enum(['start', 'center', 'end', 'stretch']).default('stretch'),
  justify: z.enum(['start', 'center', 'end', 'space-between']).default('start'),
  padding: z.number().min(0).default(0),
});
export type LayoutRowProps = z.infer<typeof LayoutRowPropsSchema>;

export const layoutRowNode: NodeDefinition = {
  type: 'layout-row',
  label: 'Rij',
  source: 'builtin',
  propsSchema: LayoutRowPropsSchema,
  bindSlots: [],
  acceptsChildren: true,
};

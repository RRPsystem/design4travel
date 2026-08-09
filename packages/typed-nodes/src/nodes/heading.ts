import { z } from 'zod';
import type { NodeDefinition } from '../types.js';

export const HeadingPropsSchema = z.object({
  text: z.string().default('Kop'),
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(2),
  align: z.enum(['left', 'center', 'right']).default('left'),
  color: z.string().optional(),
  fontSize: z.number().min(8).max(200).optional(),
});
export type HeadingProps = z.infer<typeof HeadingPropsSchema>;

export const headingNode: NodeDefinition = {
  type: 'heading',
  label: 'Kop',
  source: 'builtin',
  propsSchema: HeadingPropsSchema,
  bindSlots: [{ key: 'text', label: 'Tekst', expects: 'string' }],
  acceptsChildren: false,
};

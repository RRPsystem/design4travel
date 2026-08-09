import { z } from 'zod';
import type { NodeDefinition } from '../types.js';

export const TextPropsSchema = z.object({
  text: z.string().default('Tekst'),
  align: z.enum(['left', 'center', 'right']).default('left'),
  color: z.string().optional(),
  fontSize: z.number().min(8).max(120).optional(),
});
export type TextProps = z.infer<typeof TextPropsSchema>;

export const textNode: NodeDefinition = {
  type: 'text',
  label: 'Tekst',
  source: 'builtin',
  propsSchema: TextPropsSchema,
  bindSlots: [{ key: 'text', label: 'Tekst', expects: 'string' }],
  acceptsChildren: false,
};

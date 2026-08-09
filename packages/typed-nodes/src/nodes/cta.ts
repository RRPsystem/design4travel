import { z } from 'zod';
import type { NodeDefinition } from '../types.js';

export const CtaPropsSchema = z.object({
  text: z.string().default('Bekijk reizen'),
  href: z.string().default('#'),
  variant: z.enum(['primary', 'secondary', 'ghost']).default('primary'),
  color: z.string().optional(),
  textColor: z.string().optional(),
  size: z.enum(['sm', 'md', 'lg']).default('md'),
  align: z.enum(['left', 'center', 'right']).default('left'),
});
export type CtaProps = z.infer<typeof CtaPropsSchema>;

export const ctaNode: NodeDefinition = {
  type: 'cta',
  label: 'Call-to-action',
  source: 'builtin',
  propsSchema: CtaPropsSchema,
  bindSlots: [
    { key: 'text', label: 'Knoptekst', expects: 'string' },
    { key: 'href', label: 'Doel-URL', expects: 'string' },
  ],
  acceptsChildren: false,
};

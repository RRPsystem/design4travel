import { z } from 'zod';
import type { NodeDefinition } from '../types.js';

export const ImagePropsSchema = z.object({
  src: z.string().url().default('https://placehold.co/800x400?text=Afbeelding'),
  alt: z.string().default(''),
  width: z.number().min(1).optional(),
  height: z.number().min(1).optional(),
  radius: z.number().min(0).default(0),
});
export type ImageProps = z.infer<typeof ImagePropsSchema>;

export const imageNode: NodeDefinition = {
  type: 'image',
  label: 'Afbeelding',
  source: 'builtin',
  propsSchema: ImagePropsSchema,
  bindSlots: [
    { key: 'src', label: 'Afbeelding-URL', expects: 'image' },
    { key: 'alt', label: 'Alt-tekst', expects: 'string' },
  ],
  acceptsChildren: false,
};

import { z } from 'zod';
import type { NodeDefinition } from '../types.js';

export const HeroPropsSchema = z.object({
  title: z.string().default('Ontdek jouw volgende reis'),
  subtitle: z.string().default('Verhalen, tips en ontwerpen voor onvergetelijke reizen.'),
  imageSrc: z.string().url().default('https://placehold.co/1600x600?text=Hero'),
  imageAlt: z.string().default(''),
  overlay: z.boolean().default(true),
  height: z.number().min(200).max(1200).default(520),
  align: z.enum(['left', 'center', 'right']).default('center'),
  titleColor: z.string().default('#ffffff'),
  subtitleColor: z.string().default('#f5f5f5'),
  titleFontSize: z.number().min(16).max(200).default(56),
});
export type HeroProps = z.infer<typeof HeroPropsSchema>;

export const heroNode: NodeDefinition = {
  type: 'hero',
  label: 'Hero',
  source: 'builtin',
  propsSchema: HeroPropsSchema,
  bindSlots: [
    { key: 'title', label: 'Titel', expects: 'string' },
    { key: 'subtitle', label: 'Ondertitel', expects: 'string' },
    { key: 'imageSrc', label: 'Achtergrondafbeelding', expects: 'image' },
  ],
  acceptsChildren: false,
};

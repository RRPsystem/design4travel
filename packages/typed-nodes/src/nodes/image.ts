import { z } from 'zod';
import type { NodeDefinition } from '../types.js';
import { BoxStyleSchema } from '../style/boxStyle.js';

/**
 * Image — een enkele afbeelding met aspect-ratio-controle, object-fit,
 * focal-point, en mask-preset (voor "half rond"/"pill"/"circle"-effecten).
 *
 * BoxStyle.radius bepaalt hoek-afronding (single of per hoek voor
 * "half rond rechts"-scenarios). `maskPreset` is een expliciete shortcut
 * voor veelgevraagde patronen.
 *
 * Rendering per output:
 * - web:   <img> met object-fit + border-radius + aspect-ratio.
 * - pdf:   embed image met crop naar aspect-ratio.
 * - image: idem.
 * - docx:  gedropt naar simple embed (mask-preset genegeerd).
 */
export const ImagePropsSchema = z.object({
  src: z.string().url().default('https://placehold.co/800x400?text=Afbeelding'),
  alt: z.string().default(''),
  width: z.number().min(1).max(4000).optional(),
  height: z.number().min(1).max(4000).optional(),
  /** Aspect-ratio-forceer. String zoals '16:9' of '4:3' of '1:1'. */
  aspectRatio: z.enum(['auto', '16:9', '4:3', '3:2', '1:1', '3:4', '9:16']).default('auto'),
  objectFit: z.enum(['cover', 'contain', 'fill', 'none']).default('cover'),
  /** Focus-punt bij object-fit=cover — bepaalt welk deel zichtbaar blijft. */
  objectPosition: z.enum([
    'center', 'top', 'bottom', 'left', 'right',
    'top-left', 'top-right', 'bottom-left', 'bottom-right',
  ]).default('center'),
  /**
   * Mask-preset — shortcut voor veelgevraagde vorm-effecten. Wordt gemapt
   * naar border-radius-patronen. Bij `maskPreset != 'none'` overrules dit
   * `style.radius` niet, maar wordt eronder gerenderd — expliciete radius
   * blijft leidend.
   *   - circle:      volledig rond (radius 50%).
   *   - pill:        capsule-shape (radius = shorter-dimension/2).
   *   - arch:        top-radius groot, bottom-radius 0 (boog).
   *   - rounded:     comfortabele afronding (12-16px afhankelijk van size).
   *   - half-rounded-right / half-rounded-left: één zijde rond, andere plat.
   */
  maskPreset: z.enum([
    'none', 'circle', 'pill', 'arch', 'rounded',
    'half-rounded-right', 'half-rounded-left',
  ]).default('none'),
  /** Additionele visuele styling (border/radius per hoek/shadow/opacity). */
  style: BoxStyleSchema.optional(),
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

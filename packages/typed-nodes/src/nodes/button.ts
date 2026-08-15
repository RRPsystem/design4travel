import { z } from 'zod';
import type { NodeDefinition } from '../types.js';
import { BoxStyleSchema, ColorValueSchema } from '../style/boxStyle.js';

/**
 * Button — generieke, styleable knop-primitive. Interaction-primary (los
 * van `cta` die semantic 'page-CTA' bedoelt).
 *
 * **Zonder href of met href='#' renders als visuele badge** (span, geen <a>).
 * Voorkomt dat een button die niks doet toch klikbaar oogt. Voor "offerte-
 * nummer 992375 in blauwe button" waar geen link nodig is: renders als span
 * met dezelfde styling.
 *
 * Rendering per output:
 * - web:   <a> als interactive, <span> als visueel.
 * - pdf:   styled span met href-tekst zichtbaar als klein subscript.
 * - image: static rendering, geen interactivity.
 * - docx:  bold+underlined text met eventueel [link] achterin.
 */
export const ButtonPropsSchema = z.object({
  text: z.string().default('Knop'),
  /**
   * URL of anchor. Leeg / '#' / undefined = niet-interactief, wordt als
   * visuele label (span) gerenderd — geen fake-click-target. Voor
   * decoratieve labels/badges gebruik óf een badge-node óf laat deze leeg.
   */
  href: z.string().default(''),
  color: ColorValueSchema.optional(),
  textColor: ColorValueSchema.optional(),
  size: z.enum(['xs', 'sm', 'md', 'lg']).default('md'),
  fontWeight: z.enum(['normal', 'medium', 'semibold', 'bold']).default('semibold'),
  variant: z.enum(['solid', 'outline', 'ghost']).default('solid'),
  align: z.enum(['start', 'center', 'end', 'stretch']).default('start'),
  width: z.union([z.number().min(0).max(4000), z.enum(['auto', 'full'])]).default('auto'),
  /** Additionele visuele styling (radius/shadow/border/opacity). */
  style: BoxStyleSchema.optional(),
});
export type ButtonProps = z.infer<typeof ButtonPropsSchema>;

export const buttonNode: NodeDefinition = {
  type: 'button',
  label: 'Knop',
  source: 'builtin',
  propsSchema: ButtonPropsSchema,
  bindSlots: [
    { key: 'text', label: 'Tekst', expects: 'string' },
    { key: 'href', label: 'Doel-URL', expects: 'string' },
  ],
  acceptsChildren: false,
};

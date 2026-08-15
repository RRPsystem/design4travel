import { z } from 'zod';
import type { NodeDefinition } from '../types.js';
import { BoxStyleSchema, ColorValueSchema } from '../style/boxStyle.js';

/**
 * Shape — decoratief vorm-element (rechthoek, cirkel, ovaal). Geen inhoud,
 * puur visueel. In PR-A rendert een shape als inline-block in de doc-flow;
 * z-index/negative-offset (voor "cirkel achter foto") komt in PR-B via een
 * gecontroleerde layer/frame-primitive met anchor-based positioning.
 *
 * Rendering per output:
 * - web:   full support (div met styled dimensions + border-radius).
 * - pdf:   svg-shape of gestyleerde rechthoek.
 * - image: full support.
 * - docx:  gedropt (decoratief; geen content-verlies).
 */
export const ShapePropsSchema = z.object({
  variant: z.enum(['rectangle', 'circle', 'oval']).default('rectangle'),
  width: z.number().min(1).max(4000).default(120),
  height: z.number().min(1).max(4000).default(120),
  color: ColorValueSchema.optional(),
  /** Additionele visuele styling (border/opacity/shadow/margin). Radius
   *  wordt door variant bepaald tenzij expliciet in style.radius gezet. */
  style: BoxStyleSchema.optional(),
});
export type ShapeProps = z.infer<typeof ShapePropsSchema>;

export const shapeNode: NodeDefinition = {
  type: 'shape',
  label: 'Vorm',
  source: 'builtin',
  propsSchema: ShapePropsSchema,
  bindSlots: [],
  acceptsChildren: false,
};

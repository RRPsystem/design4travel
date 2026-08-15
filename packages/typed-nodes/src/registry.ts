import { InMemoryNodeRegistry, type NodeRegistry } from './types.js';
import { layoutRowNode } from './nodes/layout-row.js';
import { layoutColumnNode } from './nodes/layout-column.js';
import { headingNode } from './nodes/heading.js';
import { textNode } from './nodes/text.js';
import { imageNode } from './nodes/image.js';
import { heroNode } from './nodes/hero.js';
import { ctaNode } from './nodes/cta.js';
import { sectionNode } from './nodes/section.js';
import { buttonNode } from './nodes/button.js';
import { badgeNode } from './nodes/badge.js';
import { dividerNode } from './nodes/divider.js';
import { spacerNode } from './nodes/spacer.js';
import { shapeNode } from './nodes/shape.js';

export const BUILTIN_NODES = [
  layoutRowNode,
  layoutColumnNode,
  headingNode,
  textNode,
  imageNode,
  heroNode,
  ctaNode,
  sectionNode,
  buttonNode,
  badgeNode,
  dividerNode,
  spacerNode,
  shapeNode,
] as const;

export function createDefaultRegistry(): NodeRegistry {
  const reg = new InMemoryNodeRegistry();
  for (const def of BUILTIN_NODES) reg.register(def);
  return reg;
}

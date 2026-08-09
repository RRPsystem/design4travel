import { InMemoryNodeRegistry, type NodeRegistry } from './types.js';
import { layoutRowNode } from './nodes/layout-row.js';
import { layoutColumnNode } from './nodes/layout-column.js';
import { headingNode } from './nodes/heading.js';
import { textNode } from './nodes/text.js';
import { imageNode } from './nodes/image.js';
import { heroNode } from './nodes/hero.js';
import { ctaNode } from './nodes/cta.js';

export const BUILTIN_NODES = [
  layoutRowNode,
  layoutColumnNode,
  headingNode,
  textNode,
  imageNode,
  heroNode,
  ctaNode,
] as const;

export function createDefaultRegistry(): NodeRegistry {
  const reg = new InMemoryNodeRegistry();
  for (const def of BUILTIN_NODES) reg.register(def);
  return reg;
}

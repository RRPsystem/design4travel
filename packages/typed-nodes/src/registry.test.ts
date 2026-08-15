import { describe, expect, it } from 'vitest';
import { BUILTIN_NODES, createDefaultRegistry } from './registry.js';

describe('typed-nodes registry', () => {
  it('has all built-in nodes', () => {
    // 7 originele + 6 nieuwe primitives (section, button, badge, divider,
    // spacer, shape) = 13.
    expect(BUILTIN_NODES).toHaveLength(13);
  });

  it('exposes the expected types', () => {
    const types = BUILTIN_NODES.map((n) => n.type).sort();
    expect(types).toEqual(
      [
        'badge', 'button', 'cta', 'divider', 'heading', 'hero', 'image',
        'layout-column', 'layout-row', 'section', 'shape', 'spacer', 'text',
      ].sort(),
    );
  });

  it('default registry looks up built-ins', () => {
    const reg = createDefaultRegistry();
    for (const def of BUILTIN_NODES) {
      const found = reg.lookup(def.type);
      expect(found?.type).toBe(def.type);
    }
    expect(reg.lookup('unknown')).toBeUndefined();
  });

  it('every built-in node has a Zod schema that yields defaults', () => {
    for (const def of BUILTIN_NODES) {
      const parsed = def.propsSchema.safeParse({});
      expect(parsed.success, `${def.type} defaults`).toBe(true);
    }
  });

  it('every built-in node has source=builtin', () => {
    for (const def of BUILTIN_NODES) {
      expect(def.source).toBe('builtin');
    }
  });
});

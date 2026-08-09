import { describe, expect, it } from 'vitest';
import { DesignDocSchema, SCHEMA_VERSION, isDesignDoc, type DesignDoc } from './schema.js';

function makeDoc(overrides: Partial<DesignDoc> = {}): DesignDoc {
  const base: DesignDoc = {
    version: SCHEMA_VERSION,
    id: 'doc-1',
    project: { documentType: 'website', title: 'Test' },
    meta: { createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z' },
    outputs: { web: { enabled: true } },
    pages: [
      {
        id: 'page-1',
        root: {
          id: 'root-1',
          type: 'layout-column',
          props: {},
          children: [
            { id: 'h-1', type: 'heading', props: { text: 'Hello', level: 1 } },
          ],
        },
      },
    ],
  };
  return { ...base, ...overrides };
}

describe('DesignDocSchema', () => {
  it('accepts a minimal valid doc', () => {
    const doc = makeDoc();
    expect(isDesignDoc(doc)).toBe(true);
    const parsed = DesignDocSchema.parse(doc);
    expect(parsed.pages[0]!.root.type).toBe('layout-column');
  });

  it('rejects a doc without pages', () => {
    const bad = makeDoc({ pages: [] });
    expect(isDesignDoc(bad)).toBe(false);
  });

  it('rejects a node with empty type', () => {
    const bad = makeDoc({
      pages: [
        {
          id: 'p',
          root: { id: 'r', type: '', props: {} },
        },
      ],
    });
    expect(isDesignDoc(bad)).toBe(false);
  });

  it('accepts nested children recursively', () => {
    const doc = makeDoc({
      pages: [
        {
          id: 'p',
          root: {
            id: 'r',
            type: 'layout-column',
            props: {},
            children: [
              {
                id: 'row',
                type: 'layout-row',
                props: {},
                children: [{ id: 't', type: 'text', props: { text: 'x' } }],
              },
            ],
          },
        },
      ],
    });
    expect(isDesignDoc(doc)).toBe(true);
  });

  it('supports optional per-output overrides on a node', () => {
    const doc = makeDoc({
      pages: [
        {
          id: 'p',
          root: {
            id: 'r',
            type: 'heading',
            props: { text: 'x', level: 1 },
            overrides: { pdf: { props: { level: 2 } } },
          },
        },
      ],
    });
    expect(isDesignDoc(doc)).toBe(true);
  });
});

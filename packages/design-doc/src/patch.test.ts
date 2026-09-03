import { describe, expect, it } from 'vitest';
import { applyPatch, applyPatches, PatchError } from './patch.js';
import { SCHEMA_VERSION, type DesignDoc } from './schema.js';

function makeDoc(): DesignDoc {
  return {
    version: SCHEMA_VERSION,
    id: 'doc-1',
    project: { documentType: 'website', title: 'Test' },
    meta: { createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z' },
    outputs: { web: { enabled: true } },
    pages: [
      {
        id: 'page-1',
        root: {
          id: 'root',
          type: 'layout-column',
          props: {},
          children: [
            { id: 'a', type: 'heading', props: { text: 'A', level: 1 } },
            { id: 'b', type: 'heading', props: { text: 'B', level: 1 } },
          ],
        },
      },
    ],
  };
}

describe('applyPatch', () => {
  it('setProp updates a node prop', () => {
    const doc = makeDoc();
    const next = applyPatch(doc, { kind: 'setProp', nodeId: 'a', key: 'text', value: 'Aa' });
    expect(next.pages[0]!.root.children![0]!.props.text).toBe('Aa');
    expect(doc.pages[0]!.root.children![0]!.props.text).toBe('A'); // immutability
  });

  it('setProps merges', () => {
    const doc = makeDoc();
    const next = applyPatch(doc, {
      kind: 'setProps',
      nodeId: 'a',
      props: { level: 2, extra: true },
    });
    expect(next.pages[0]!.root.children![0]!.props).toMatchObject({
      text: 'A',
      level: 2,
      extra: true,
    });
  });

  it('setBind sets and clears bind slots', () => {
    const doc = makeDoc();
    const set = applyPatch(doc, {
      kind: 'setBind',
      nodeId: 'a',
      key: 'text',
      path: 'accommodation.name',
    });
    expect(set.pages[0]!.root.children![0]!.bind).toEqual({ text: 'accommodation.name' });
    const cleared = applyPatch(set, { kind: 'setBind', nodeId: 'a', key: 'text', path: null });
    expect(cleared.pages[0]!.root.children![0]!.bind).toEqual({});
  });

  it('reorderChildren swaps order', () => {
    const doc = makeDoc();
    const next = applyPatch(doc, {
      kind: 'reorderChildren',
      parentId: 'root',
      order: ['b', 'a'],
    });
    expect(next.pages[0]!.root.children!.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('insertNode adds a child at index', () => {
    const doc = makeDoc();
    const next = applyPatch(doc, {
      kind: 'insertNode',
      parentId: 'root',
      index: 1,
      node: { id: 'c', type: 'text', props: { text: 'C' } },
    });
    expect(next.pages[0]!.root.children!.map((c) => c.id)).toEqual(['a', 'c', 'b']);
  });

  it('removeNode removes a node from its parent', () => {
    const doc = makeDoc();
    const next = applyPatch(doc, { kind: 'removeNode', nodeId: 'a' });
    expect(next.pages[0]!.root.children!.map((c) => c.id)).toEqual(['b']);
  });

  it('setBrandToken sets a token', () => {
    const doc = makeDoc();
    const next = applyPatch(doc, {
      kind: 'setBrandToken',
      key: 'brand.primary',
      value: '#0057ff',
    });
    expect(next.brandTokens).toEqual({ 'brand.primary': '#0057ff' });
  });

  it('throws PatchError on unknown nodeId', () => {
    const doc = makeDoc();
    expect(() =>
      applyPatch(doc, { kind: 'setProp', nodeId: 'zzz', key: 'x', value: 1 }),
    ).toThrow(PatchError);
  });

  it('applyPatches chains multiple ops', () => {
    const doc = makeDoc();
    const next = applyPatches(doc, [
      { kind: 'setProp', nodeId: 'a', key: 'text', value: '1' },
      { kind: 'setProp', nodeId: 'b', key: 'text', value: '2' },
    ]);
    expect(next.pages[0]!.root.children![0]!.props.text).toBe('1');
    expect(next.pages[0]!.root.children![1]!.props.text).toBe('2');
  });

  it('addPage inserts a new page at end by default', () => {
    const doc = makeDoc();
    const next = applyPatch(doc, {
      kind: 'addPage',
      page: {
        id: 'page-golf',
        name: 'Golfreis',
        root: { id: 'golf-root', type: 'layout-column', props: {}, children: [] },
      },
    });
    expect(next.pages).toHaveLength(2);
    expect(next.pages[1]!.id).toBe('page-golf');
    expect(next.pages[1]!.name).toBe('Golfreis');
  });

  it('addPage respects explicit index', () => {
    const doc = makeDoc();
    const next = applyPatch(doc, {
      kind: 'addPage',
      index: 0,
      page: {
        id: 'page-cover',
        name: 'Cover',
        root: { id: 'cover-root', type: 'layout-column', props: {}, children: [] },
      },
    });
    expect(next.pages[0]!.id).toBe('page-cover');
    expect(next.pages[1]!.id).toBe('page-1');
  });

  it('addPage rejects duplicate page id', () => {
    const doc = makeDoc();
    expect(() =>
      applyPatch(doc, {
        kind: 'addPage',
        page: {
          id: 'page-1', // botsing met bestaande page
          root: { id: 'x', type: 'layout-column', props: {} },
        },
      }),
    ).toThrow(PatchError);
  });

  it('removePage removes a page', () => {
    const doc = makeDoc();
    const twoPages = applyPatch(doc, {
      kind: 'addPage',
      page: {
        id: 'page-2',
        root: { id: 'root2', type: 'layout-column', props: {} },
      },
    });
    const removed = applyPatch(twoPages, { kind: 'removePage', pageId: 'page-1' });
    expect(removed.pages).toHaveLength(1);
    expect(removed.pages[0]!.id).toBe('page-2');
  });

  it('removePage refuses to remove the only remaining page', () => {
    const doc = makeDoc();
    expect(() =>
      applyPatch(doc, { kind: 'removePage', pageId: 'page-1' }),
    ).toThrow(PatchError);
  });

  it('renamePage sets the name', () => {
    const doc = makeDoc();
    const next = applyPatch(doc, {
      kind: 'renamePage',
      pageId: 'page-1',
      name: 'Home',
    });
    expect(next.pages[0]!.name).toBe('Home');
  });

  it('reorderPages permutes pages', () => {
    const doc = applyPatch(makeDoc(), {
      kind: 'addPage',
      page: {
        id: 'page-2',
        root: { id: 'root2', type: 'layout-column', props: {} },
      },
    });
    const next = applyPatch(doc, {
      kind: 'reorderPages',
      order: ['page-2', 'page-1'],
    });
    expect(next.pages.map((p) => p.id)).toEqual(['page-2', 'page-1']);
  });

  it('reorderPages rejects invalid order (missing id)', () => {
    const doc = makeDoc();
    expect(() =>
      applyPatch(doc, { kind: 'reorderPages', order: ['ghost'] }),
    ).toThrow(PatchError);
  });

  it('preserves project.contentSourceId across a batch of unrelated patches', () => {
    const CONTENT_SOURCE_ID = '11111111-2222-4333-8444-555555555555';
    const doc: DesignDoc = {
      ...makeDoc(),
      project: {
        documentType: 'website',
        title: 'Test',
        contentSourceId: CONTENT_SOURCE_ID,
      },
    };
    const next = applyPatches(doc, [
      { kind: 'setProp', nodeId: 'a', key: 'text', value: 'Aa' },
      { kind: 'insertNode', parentId: 'root', index: 0, node: { id: 'x', type: 'text', props: { text: 'x' } } },
      { kind: 'setBrandToken', key: 'primary', value: '#fff' },
      { kind: 'addPage', page: { id: 'p2', root: { id: 'r2', type: 'layout-column', props: {} } } },
      { kind: 'renamePage', pageId: 'p2', name: 'Second' },
    ]);
    expect(next.project.contentSourceId).toBe(CONTENT_SOURCE_ID);
  });
});

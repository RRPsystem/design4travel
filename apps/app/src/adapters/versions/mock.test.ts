import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type DesignDoc } from '@design4/design-doc';
import { createMockVersionHistoryAdapter } from './mock.js';

const DOC_ID = 'doc-1';

function makeDoc(overrides: Partial<DesignDoc> = {}): DesignDoc {
  const base: DesignDoc = {
    version: SCHEMA_VERSION,
    id: DOC_ID,
    project: { documentType: 'website', title: 'Test' },
    meta: {
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    outputs: { web: { enabled: true } },
    pages: [
      {
        id: 'p1',
        name: 'Home',
        root: { id: 'root', type: 'layout-column', props: {}, children: [] },
      },
    ],
  };
  return { ...base, ...overrides };
}

describe('MockVersionHistoryAdapter', () => {
  it('starts empty and grows on recordSnapshot', async () => {
    const a = createMockVersionHistoryAdapter();
    expect(await a.list(DOC_ID)).toEqual([]);
    const s1 = a.recordSnapshot(DOC_ID, makeDoc());
    expect(s1.version_number).toBe(1);
    expect(a.getCurrentLockVersion(DOC_ID)).toBe(1);
    a.recordSnapshot(DOC_ID, makeDoc());
    a.recordSnapshot(DOC_ID, makeDoc());
    const list = await a.list(DOC_ID);
    // Nieuwste eerst.
    expect(list.map((v) => v.version_number)).toEqual([3, 2, 1]);
    expect(a.getCurrentLockVersion(DOC_ID)).toBe(3);
  });

  it('get returns the exact doc content of a version', async () => {
    const a = createMockVersionHistoryAdapter();
    a.recordSnapshot(DOC_ID, makeDoc({ project: { documentType: 'website', title: 'V1' } }));
    a.recordSnapshot(DOC_ID, makeDoc({ project: { documentType: 'website', title: 'V2' } }));
    const v1 = await a.get(DOC_ID, 1);
    const v2 = await a.get(DOC_ID, 2);
    expect(v1?.doc.project.title).toBe('V1');
    expect(v2?.doc.project.title).toBe('V2');
  });

  it('get returns null for unknown version', async () => {
    const a = createMockVersionHistoryAdapter();
    a.recordSnapshot(DOC_ID, makeDoc());
    expect(await a.get(DOC_ID, 99)).toBeNull();
    expect(await a.get('other', 1)).toBeNull();
  });

  it('rollback creates a NEW version with restored content and bumps lock_version', async () => {
    const a = createMockVersionHistoryAdapter();
    a.recordSnapshot(DOC_ID, makeDoc({ project: { documentType: 'website', title: 'V1' } }));
    a.recordSnapshot(DOC_ID, makeDoc({ project: { documentType: 'website', title: 'V2' } }));
    const before = a.getCurrentLockVersion(DOC_ID);
    expect(before).toBe(2);
    const result = await a.rollback(DOC_ID, 1, before);
    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow for TS
    expect(result.new_version_number).toBe(3);
    expect(result.new_lock_version).toBe(3);
    const v3 = await a.get(DOC_ID, 3);
    expect(v3?.doc.project.title).toBe('V1');
    // Historie behouden: V2 staat er nog.
    const v2 = await a.get(DOC_ID, 2);
    expect(v2?.doc.project.title).toBe('V2');
  });

  it('rollback with mismatched expectedLockVersion → lock_version_mismatch', async () => {
    const a = createMockVersionHistoryAdapter();
    a.recordSnapshot(DOC_ID, makeDoc());
    a.recordSnapshot(DOC_ID, makeDoc());
    const result = await a.rollback(DOC_ID, 1, 999);
    expect(result).toEqual({ ok: false, error: 'lock_version_mismatch' });
  });

  it('rollback to non-existent target → target_version_not_found', async () => {
    const a = createMockVersionHistoryAdapter();
    a.recordSnapshot(DOC_ID, makeDoc());
    const result = await a.rollback(DOC_ID, 99, 1);
    expect(result).toEqual({ ok: false, error: 'target_version_not_found' });
  });

  it('rollback for unknown document → not_found', async () => {
    const a = createMockVersionHistoryAdapter();
    const result = await a.rollback('nope', 1, 0);
    expect(result).toEqual({ ok: false, error: 'not_found' });
  });

  it('rollback across schema versions → target_schema_version_incompatible', async () => {
    const a = createMockVersionHistoryAdapter();
    a.recordSnapshot(DOC_ID, makeDoc({ version: '0.1.0' }));
    a.recordSnapshot(DOC_ID, makeDoc({ version: '0.2.0' }));
    // Actueel = 0.2.0, target v1 = 0.1.0 → incompatible.
    const result = await a.rollback(DOC_ID, 1, 2);
    expect(result).toEqual({ ok: false, error: 'target_schema_version_incompatible' });
  });

  it('simulateNextRollbackError forces the next call to fail with the given code', async () => {
    const a = createMockVersionHistoryAdapter();
    a.recordSnapshot(DOC_ID, makeDoc());
    a.simulateNextRollbackError('insufficient_role');
    const first = await a.rollback(DOC_ID, 1, 1);
    expect(first).toEqual({ ok: false, error: 'insufficient_role' });
    // Consumed after one call — daarna weer normaal.
    const second = await a.rollback(DOC_ID, 1, 1);
    expect(second.ok).toBe(true);
  });

  it('recordSnapshot deep-clones the doc so later mutation does not affect history', async () => {
    const a = createMockVersionHistoryAdapter();
    const doc = makeDoc({ project: { documentType: 'website', title: 'first' } });
    a.recordSnapshot(DOC_ID, doc);
    // Mutate the source after recording — snapshot must be unaffected.
    doc.project.title = 'mutated';
    const v1 = await a.get(DOC_ID, 1);
    expect(v1?.doc.project.title).toBe('first');
  });
});

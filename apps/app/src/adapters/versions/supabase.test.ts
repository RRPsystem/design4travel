import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SCHEMA_VERSION, type DesignDoc } from '@design4/design-doc';
import { createSupabaseVersionHistoryAdapter } from './supabase.js';

const DOC_ID = '22222222-2222-2222-2222-222222222222';

function makeDoc(): DesignDoc {
  return {
    version: SCHEMA_VERSION,
    id: DOC_ID,
    project: { documentType: 'website', title: 'T' },
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
}

interface ListStub {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: (fn: (r: unknown) => unknown) => Promise<unknown>;
}

function makeStub(terminal: { data: unknown; error: unknown }): ListStub {
  const stub: ListStub = {
    select: vi.fn(() => stub),
    eq: vi.fn(() => stub),
    order: vi.fn(() => stub),
    maybeSingle: vi.fn(async () => terminal),
    then: (fn) => Promise.resolve(terminal).then(fn),
  };
  return stub;
}

function makeClient(opts: {
  fromResult?: { data: unknown; error: unknown };
  invokeResult?: { data: unknown; error: unknown };
}): {
  client: SupabaseClient;
  invoke: ReturnType<typeof vi.fn>;
} {
  const stub = makeStub(opts.fromResult ?? { data: null, error: null });
  const invoke = vi.fn(async () => opts.invokeResult ?? { data: null, error: null });
  const client: Partial<SupabaseClient> = {
    from: vi.fn(() => stub) as unknown as SupabaseClient['from'],
    functions: { invoke } as unknown as SupabaseClient['functions'],
  };
  return { client: client as SupabaseClient, invoke };
}

describe('SupabaseVersionHistoryAdapter — list', () => {
  it('returns summaries newest-first', async () => {
    const { client } = makeClient({
      fromResult: {
        data: [
          { version_number: 3, created_at: '2026-01-03T00:00:00Z', author_id: null, author_label: null, author_note: null },
          { version_number: 2, created_at: '2026-01-02T00:00:00Z', author_id: null, author_label: null, author_note: null },
          { version_number: 1, created_at: '2026-01-01T00:00:00Z', author_id: null, author_label: null, author_note: null },
        ],
        error: null,
      },
    });
    const adapter = createSupabaseVersionHistoryAdapter({
      client,
      onLockVersionUpdate: vi.fn(),
    });
    const list = await adapter.list(DOC_ID);
    expect(list.map((v) => v.version_number)).toEqual([3, 2, 1]);
    // null author fields worden weggelaten in de summary (optional)
    expect(list[0]).not.toHaveProperty('author_id');
  });

  it('throws when the query errors', async () => {
    const { client } = makeClient({
      fromResult: { data: null, error: { message: 'RLS' } },
    });
    const adapter = createSupabaseVersionHistoryAdapter({
      client,
      onLockVersionUpdate: vi.fn(),
    });
    await expect(adapter.list(DOC_ID)).rejects.toThrow(/RLS/);
  });
});

describe('SupabaseVersionHistoryAdapter — get', () => {
  it('returns snapshot with doc.id normalized to projectDocumentId', async () => {
    const persisted = { ...makeDoc(), id: 'some-old-id' };
    const { client } = makeClient({
      fromResult: {
        data: {
          version_number: 5,
          created_at: '2026-01-05T00:00:00Z',
          author_id: null,
          author_label: null,
          author_note: null,
          doc: persisted,
        },
        error: null,
      },
    });
    const adapter = createSupabaseVersionHistoryAdapter({
      client,
      onLockVersionUpdate: vi.fn(),
    });
    const snap = await adapter.get(DOC_ID, 5);
    expect(snap).not.toBeNull();
    expect(snap!.version_number).toBe(5);
    expect(snap!.doc.id).toBe(DOC_ID);
  });

  it('returns null when no row', async () => {
    const { client } = makeClient({ fromResult: { data: null, error: null } });
    const adapter = createSupabaseVersionHistoryAdapter({
      client,
      onLockVersionUpdate: vi.fn(),
    });
    expect(await adapter.get(DOC_ID, 42)).toBeNull();
  });
});

describe('SupabaseVersionHistoryAdapter — rollback', () => {
  it('happy path invokes rollback-document and calls onLockVersionUpdate', async () => {
    const { client, invoke } = makeClient({
      invokeResult: {
        data: { new_lock_version: 7, new_version_number: 7 },
        error: null,
      },
    });
    const onUpdate = vi.fn();
    const adapter = createSupabaseVersionHistoryAdapter({
      client,
      onLockVersionUpdate: onUpdate,
    });
    const res = await adapter.rollback(DOC_ID, 3, 6);
    expect(invoke).toHaveBeenCalledWith('rollback-document', {
      body: {
        project_document_id: DOC_ID,
        target_version_number: 3,
        expected_lock_version: 6,
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.new_lock_version).toBe(7);
      expect(res.new_version_number).toBe(7);
    }
    expect(onUpdate).toHaveBeenCalledWith(7);
  });

  it('maps 409 lock_version_mismatch to RollbackErrorCode; does NOT call onLockVersionUpdate', async () => {
    const { client } = makeClient({
      invokeResult: {
        data: null,
        error: {
          context: new Response(
            JSON.stringify({ error: 'lock_version_mismatch' }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
        },
      },
    });
    const onUpdate = vi.fn();
    const adapter = createSupabaseVersionHistoryAdapter({
      client,
      onLockVersionUpdate: onUpdate,
    });
    const res = await adapter.rollback(DOC_ID, 3, 6);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('lock_version_mismatch');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('unknown error codes fall back to internal_error', async () => {
    const { client } = makeClient({
      invokeResult: {
        data: null,
        error: {
          context: new Response(JSON.stringify({ error: 'weird_new_code' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
        },
      },
    });
    const adapter = createSupabaseVersionHistoryAdapter({
      client,
      onLockVersionUpdate: vi.fn(),
    });
    const res = await adapter.rollback(DOC_ID, 1, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('internal_error');
  });

  it('network failure (no context) → internal_error', async () => {
    const { client } = makeClient({
      invokeResult: { data: null, error: new Error('network') },
    });
    const adapter = createSupabaseVersionHistoryAdapter({
      client,
      onLockVersionUpdate: vi.fn(),
    });
    const res = await adapter.rollback(DOC_ID, 1, 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('internal_error');
  });
});

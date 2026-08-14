import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SCHEMA_VERSION, type DesignDoc } from '@design4/design-doc';
import {
  createSupabasePersistenceAdapter,
  isLockVersionMismatch,
  LockVersionMismatchError,
} from './supabase.js';

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
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

function makeClient(opts: {
  invokeResult?: { data: unknown; error: unknown };
  loadResult?: { data: unknown; error: unknown };
}): {
  client: SupabaseClient;
  invoke: ReturnType<typeof vi.fn>;
  loadStub: {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
  };
} {
  const invoke = vi.fn(async () => opts.invokeResult ?? { data: null, error: null });
  const terminal = opts.loadResult ?? { data: null, error: null };
  const loadStub = {
    select: vi.fn(() => loadStub),
    eq: vi.fn(() => loadStub),
    maybeSingle: vi.fn(async () => terminal),
  } as unknown as {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
  };
  const client: Partial<SupabaseClient> = {
    from: vi.fn(() => loadStub) as unknown as SupabaseClient['from'],
    functions: { invoke } as unknown as SupabaseClient['functions'],
  };
  return { client: client as SupabaseClient, invoke, loadStub };
}

describe('SupabasePersistenceAdapter — save', () => {
  it('sends the correct body and calls onLockVersionUpdate on 200', async () => {
    const { client, invoke } = makeClient({
      invokeResult: { data: { new_lock_version: 4 }, error: null },
    });
    const onUpdate = vi.fn();
    const adapter = createSupabasePersistenceAdapter({
      client,
      projectId: PROJECT_ID,
      schemaVersion: SCHEMA_VERSION,
      getExpectedLockVersion: () => 3,
      onLockVersionUpdate: onUpdate,
    });
    const doc = makeDoc();
    await adapter.save(DOC_ID, doc);
    expect(invoke).toHaveBeenCalledWith('save-document', {
      body: {
        project_id: PROJECT_ID,
        doc,
        schema_version: SCHEMA_VERSION,
        expected_lock_version: 3,
      },
    });
    expect(onUpdate).toHaveBeenCalledWith(4);
  });

  it('throws LockVersionMismatchError on 409 lock_version_mismatch', async () => {
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
    const adapter = createSupabasePersistenceAdapter({
      client,
      projectId: PROJECT_ID,
      schemaVersion: SCHEMA_VERSION,
      getExpectedLockVersion: () => 3,
      onLockVersionUpdate: onUpdate,
    });
    let err: unknown = null;
    try {
      await adapter.save(DOC_ID, makeDoc());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LockVersionMismatchError);
    expect(isLockVersionMismatch(err)).toBe(true);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('throws generic Error on other HTTP failures', async () => {
    const { client } = makeClient({
      invokeResult: {
        data: null,
        error: {
          context: new Response('{"error":"insufficient_role"}', {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
        },
      },
    });
    const onUpdate = vi.fn();
    const adapter = createSupabasePersistenceAdapter({
      client,
      projectId: PROJECT_ID,
      schemaVersion: SCHEMA_VERSION,
      getExpectedLockVersion: () => 3,
      onLockVersionUpdate: onUpdate,
    });
    await expect(adapter.save(DOC_ID, makeDoc())).rejects.toThrow(/save-document failed/);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('throws when new_lock_version is missing from response', async () => {
    const { client } = makeClient({
      invokeResult: { data: { }, error: null },
    });
    const adapter = createSupabasePersistenceAdapter({
      client,
      projectId: PROJECT_ID,
      schemaVersion: SCHEMA_VERSION,
      getExpectedLockVersion: () => 1,
      onLockVersionUpdate: vi.fn(),
    });
    await expect(adapter.save(DOC_ID, makeDoc())).rejects.toThrow(/new_lock_version/);
  });
});

describe('SupabasePersistenceAdapter — load', () => {
  it('validates and returns doc, rewriting id to docId', async () => {
    const persisted = { ...makeDoc(), id: 'some-old-id' };
    const { client } = makeClient({
      loadResult: { data: { doc: persisted }, error: null },
    });
    const adapter = createSupabasePersistenceAdapter({
      client,
      projectId: PROJECT_ID,
      schemaVersion: SCHEMA_VERSION,
      getExpectedLockVersion: () => 1,
      onLockVersionUpdate: vi.fn(),
    });
    const loaded = await adapter.load(DOC_ID);
    expect(loaded?.id).toBe(DOC_ID);
  });

  it('returns null when no row', async () => {
    const { client } = makeClient({ loadResult: { data: null, error: null } });
    const adapter = createSupabasePersistenceAdapter({
      client,
      projectId: PROJECT_ID,
      schemaVersion: SCHEMA_VERSION,
      getExpectedLockVersion: () => 1,
      onLockVersionUpdate: vi.fn(),
    });
    expect(await adapter.load(DOC_ID)).toBeNull();
  });
});

describe('SupabasePersistenceAdapter — delete', () => {
  it('throws NotImplemented', async () => {
    const { client } = makeClient({});
    const adapter = createSupabasePersistenceAdapter({
      client,
      projectId: PROJECT_ID,
      schemaVersion: SCHEMA_VERSION,
      getExpectedLockVersion: () => 1,
      onLockVersionUpdate: vi.fn(),
    });
    await expect(adapter.delete(DOC_ID)).rejects.toThrow(/not implemented/i);
  });
});

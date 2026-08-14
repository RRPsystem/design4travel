import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SCHEMA_VERSION, type DesignDoc } from '@design4/design-doc';
import { bootstrapDocument } from './bootstrap.js';

const PROJECT_UUID = '11111111-1111-1111-1111-111111111111';
const PROJECT_DOC_UUID = '22222222-2222-2222-2222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makeSeed(overrides: Partial<DesignDoc> = {}): DesignDoc {
  return {
    version: SCHEMA_VERSION,
    id: 'seed-landing',
    project: { documentType: 'website', title: 'Seed' },
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
    ...overrides,
  };
}

interface FakeQuery {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: (fn: (r: unknown) => unknown) => Promise<unknown>;
}

/**
 * Bouwt een chainable query-stub. Elke chained method retourneert de stub zelf.
 * `terminal` is de "await result" die de `.then` teruggeeft en die
 * `.maybeSingle()` ook returnt.
 */
function makeQueryStub(terminal: { data: unknown; error: unknown }): FakeQuery {
  const q: FakeQuery = {
    select: vi.fn(() => q),
    eq: vi.fn(() => q),
    is: vi.fn(() => q),
    order: vi.fn(() => q),
    maybeSingle: vi.fn(async () => terminal),
    then: (fn) => Promise.resolve(terminal).then(fn),
  };
  return q;
}

function makeClient(opts: {
  session?: { user: { id: string } } | null;
  membersResult: { data: unknown; error: unknown };
  invokeResults?: Record<string, { data: unknown; error: unknown }>;
  docSelectResult?: { data: unknown; error: unknown };
}): SupabaseClient {
  const membersStub = makeQueryStub(opts.membersResult);
  const docStub = makeQueryStub(
    opts.docSelectResult ?? { data: { doc: {} }, error: null },
  );
  const invoke = vi.fn(async (fnName: string) => {
    const hit = opts.invokeResults?.[fnName];
    return hit ?? { data: null, error: new Error(`no mock for ${fnName}`) };
  });

  const client: Partial<SupabaseClient> = {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: opts.session ?? null },
        error: null,
      })),
    } as unknown as SupabaseClient['auth'],
    from: vi.fn((table: string) => {
      if (table === 'organization_members') return membersStub;
      if (table === 'project_documents') return docStub;
      throw new Error(`unexpected from(${table})`);
    }) as unknown as SupabaseClient['from'],
    functions: { invoke } as unknown as SupabaseClient['functions'],
  };
  return client as SupabaseClient;
}

describe('bootstrapDocument', () => {
  it('returns auth_required when no session', async () => {
    const client = makeClient({
      session: null,
      membersResult: { data: [], error: null },
    });
    const res = await bootstrapDocument({ client, seedDoc: makeSeed() });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('auth_required');
  });

  it('returns no_active_organization when 0 memberships', async () => {
    const client = makeClient({
      session: { user: { id: USER_ID } },
      membersResult: { data: [], error: null },
    });
    const res = await bootstrapDocument({ client, seedDoc: makeSeed() });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no_active_organization');
  });

  it('returns multiple_active_organizations with list when >1 memberships', async () => {
    const client = makeClient({
      session: { user: { id: USER_ID } },
      membersResult: {
        data: [
          { organization_id: ORG_A, organizations: { id: ORG_A, name: 'Alpha', deleted_at: null } },
          { organization_id: ORG_B, organizations: { id: ORG_B, name: 'Beta', deleted_at: null } },
        ],
        error: null,
      },
    });
    const res = await bootstrapDocument({ client, seedDoc: makeSeed() });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('multiple_active_organizations');
      expect(res.organizations?.map((o) => o.name).sort()).toEqual(['Alpha', 'Beta']);
    }
  });

  it('happy path — one active org invokes create-project-document then loads doc', async () => {
    const seedDoc = makeSeed({ project: { documentType: 'website', title: 'Mijn ontwerp' } });
    const persistedDoc = { ...seedDoc, id: 'seed-landing' }; // server stored our seed as-is
    const client = makeClient({
      session: { user: { id: USER_ID } },
      membersResult: {
        data: [
          { organization_id: ORG_A, organizations: { id: ORG_A, name: 'Alpha', deleted_at: null } },
        ],
        error: null,
      },
      invokeResults: {
        'create-project-document': {
          data: {
            project_id: PROJECT_UUID,
            project_document_id: PROJECT_DOC_UUID,
            lock_version: 1,
          },
          error: null,
        },
      },
      docSelectResult: { data: { doc: persistedDoc }, error: null },
    });

    const res = await bootstrapDocument({ client, seedDoc });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.projectId).toBe(PROJECT_UUID);
      expect(res.projectDocumentId).toBe(PROJECT_DOC_UUID);
      expect(res.lockVersion).toBe(1);
      // doc.id herschreven naar de project_document_id (UUID)
      expect(res.doc.id).toBe(PROJECT_DOC_UUID);
      expect(res.doc.project.title).toBe('Mijn ontwerp');
    }

    // verifieer invoke-call bevatte de juiste body
    const invokeMock = client.functions.invoke as unknown as ReturnType<typeof vi.fn>;
    expect(invokeMock).toHaveBeenCalledWith('create-project-document', {
      body: expect.objectContaining({
        organization_id: ORG_A,
        document_type: 'website',
        schema_version: SCHEMA_VERSION,
        seed_doc: seedDoc,
      }),
    });
  });

  it('returns internal_error when create-project-document HTTP-errors', async () => {
    const client = makeClient({
      session: { user: { id: USER_ID } },
      membersResult: {
        data: [
          { organization_id: ORG_A, organizations: { id: ORG_A, name: 'Alpha', deleted_at: null } },
        ],
        error: null,
      },
      invokeResults: {
        'create-project-document': {
          data: null,
          error: {
            context: new Response(JSON.stringify({ error: 'membership_not_active' }), {
              status: 403,
              headers: { 'content-type': 'application/json' },
            }),
          },
        },
      },
    });
    const res = await bootstrapDocument({ client, seedDoc: makeSeed() });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('internal_error');
      expect(res.detail).toContain('membership_not_active');
    }
  });
});

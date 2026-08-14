import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SCHEMA_VERSION, type DesignDoc } from '@design4/design-doc';
import { ClaudeAIAdapter } from './claudeAI.js';

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

function makeClient(opts: { invokeResult?: { data: unknown; error: unknown } }): {
  client: SupabaseClient;
  invoke: ReturnType<typeof vi.fn>;
} {
  const invoke = vi.fn(async () => opts.invokeResult ?? { data: null, error: null });
  const client: Partial<SupabaseClient> = {
    functions: { invoke } as unknown as SupabaseClient['functions'],
  };
  return { client: client as SupabaseClient, invoke };
}

describe('ClaudeAIAdapter', () => {
  it('sends project_document_id + prompt (no selected_node_id when absent)', async () => {
    const { client, invoke } = makeClient({
      invokeResult: {
        data: {
          assistantMessage: 'Hero-titel op 66px gezet.',
          patches: [{ kind: 'setProp', nodeId: 'hero', key: 'titleFontSize', value: 66 }],
        },
        error: null,
      },
    });
    const adapter = new ClaudeAIAdapter({ client, projectDocumentId: DOC_ID });
    const res = await adapter.generatePatch({ doc: makeDoc() }, 'maak titel groter');

    expect(invoke).toHaveBeenCalledWith('generate-patch', {
      body: {
        project_document_id: DOC_ID,
        prompt: 'maak titel groter',
      },
    });
    expect(res.assistantMessage).toBe('Hero-titel op 66px gezet.');
    expect(res.patches).toHaveLength(1);
  });

  it('includes selected_node_id when present in context', async () => {
    const { client, invoke } = makeClient({
      invokeResult: {
        data: { assistantMessage: '', patches: [] },
        error: null,
      },
    });
    const adapter = new ClaudeAIAdapter({ client, projectDocumentId: DOC_ID });
    await adapter.generatePatch({ doc: makeDoc(), selectedNodeId: 'hero' }, 'kleiner');

    expect(invoke).toHaveBeenCalledWith('generate-patch', {
      body: {
        project_document_id: DOC_ID,
        prompt: 'kleiner',
        selected_node_id: 'hero',
      },
    });
  });

  it('throws on non-2xx (HTTP error) with status + code in message', async () => {
    const { client } = makeClient({
      invokeResult: {
        data: null,
        error: {
          context: new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
        },
      },
    });
    const adapter = new ClaudeAIAdapter({ client, projectDocumentId: DOC_ID });
    await expect(
      adapter.generatePatch({ doc: makeDoc() }, 'x'),
    ).rejects.toThrow(/status=429/);
  });

  it('throws on malformed response shape', async () => {
    const { client } = makeClient({
      invokeResult: {
        data: { patches: 'not-an-array' }, // missing assistantMessage, wrong patches type
        error: null,
      },
    });
    const adapter = new ClaudeAIAdapter({ client, projectDocumentId: DOC_ID });
    await expect(
      adapter.generatePatch({ doc: makeDoc() }, 'x'),
    ).rejects.toThrow(/malformed/);
  });
});

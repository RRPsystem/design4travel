import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SCHEMA_VERSION, type DesignDoc } from '@design4/design-doc';
import { ClaudeAIAdapter } from './claudeAI.js';
import type { AIStreamEvent } from './types.js';

const DOC_ID = '22222222-2222-2222-2222-222222222222';
const SUPABASE_URL = 'https://example.supabase.co';
const ANON_KEY = 'sb_publishable_test';
const ACCESS_TOKEN = 'user-jwt-token';

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

function makeClient(): SupabaseClient {
  return {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: ACCESS_TOKEN } as never },
        error: null,
      }),
    },
  } as unknown as SupabaseClient;
}

function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Build a ReadableStream from an array of SSE-encoded strings. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function mockFetchOnce(response: Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => response));
}

function makeAdapter() {
  return new ClaudeAIAdapter({
    client: makeClient(),
    projectDocumentId: DOC_ID,
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: ANON_KEY,
  });
}

describe('ClaudeAIAdapter — streaming', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the edge function with correct URL, headers, and body', async () => {
    const doneEvent = sseChunk('done', {
      kind: 'done',
      assistantMessage: 'OK',
      patches: [],
    });
    mockFetchOnce(
      new Response(sseStream([doneEvent]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const adapter = makeAdapter();
    await adapter.generatePatch({ doc: makeDoc() }, 'maak titel groter');

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${SUPABASE_URL}/functions/v1/generate-patch`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      apikey: ANON_KEY,
      authorization: `Bearer ${ACCESS_TOKEN}`,
      accept: 'text/event-stream',
    });
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      project_document_id: DOC_ID,
      prompt: 'maak titel groter',
    });
  });

  it('includes selected_node_id + history when provided', async () => {
    mockFetchOnce(
      new Response(
        sseStream([sseChunk('done', { kind: 'done', assistantMessage: '', patches: [] })]),
        { status: 200 },
      ),
    );
    const adapter = makeAdapter();
    await adapter.generatePatch(
      {
        doc: makeDoc(),
        selectedNodeId: 'hero',
        history: [
          { role: 'user', content: 'vorige' },
          { role: 'assistant', content: 'antwoord' },
        ],
      },
      'nu iets anders',
    );
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body).toEqual({
      project_document_id: DOC_ID,
      prompt: 'nu iets anders',
      selected_node_id: 'hero',
      history: [
        { role: 'user', content: 'vorige' },
        { role: 'assistant', content: 'antwoord' },
      ],
    });
  });

  it('forwards activity events to onEvent as they stream in', async () => {
    const chunks = [
      sseChunk('activity', { kind: 'model_change', model: 'claude-sonnet-5' }),
      sseChunk('activity', { kind: 'text_delta', text: 'Hoi ' }),
      sseChunk('activity', { kind: 'text_delta', text: 'daar' }),
      sseChunk('activity', { kind: 'tool_start', index: 0, tool: 'set_prop' }),
      sseChunk('activity', {
        kind: 'tool_complete',
        index: 0,
        tool: 'set_prop',
        summary: 'hero.title = "X"',
      }),
      sseChunk('done', {
        kind: 'done',
        assistantMessage: 'Hoi daar',
        patches: [{ kind: 'setProp', nodeId: 'hero', key: 'title', value: 'X' }],
      }),
    ];
    mockFetchOnce(new Response(sseStream(chunks), { status: 200 }));

    const events: AIStreamEvent[] = [];
    const adapter = makeAdapter();
    const res = await adapter.generatePatch(
      { doc: makeDoc() },
      'change title',
      (e) => events.push(e),
    );

    expect(events).toEqual([
      { kind: 'model_change', model: 'claude-sonnet-5' },
      { kind: 'text_delta', text: 'Hoi ' },
      { kind: 'text_delta', text: 'daar' },
      { kind: 'tool_start', index: 0, tool: 'set_prop' },
      {
        kind: 'tool_complete',
        index: 0,
        tool: 'set_prop',
        summary: 'hero.title = "X"',
      },
    ]);
    expect(res.assistantMessage).toBe('Hoi daar');
    expect(res.patches).toHaveLength(1);
  });

  it('handles chunk-boundaries mid-event (SSE re-assembly)', async () => {
    // Split one event over multiple chunks to prove the parser re-assembles.
    const full = sseChunk('done', {
      kind: 'done',
      assistantMessage: 'A',
      patches: [],
    });
    const half = Math.floor(full.length / 2);
    const chunks = [full.slice(0, half), full.slice(half)];
    mockFetchOnce(new Response(sseStream(chunks), { status: 200 }));

    const adapter = makeAdapter();
    const res = await adapter.generatePatch({ doc: makeDoc() }, 'x');
    expect(res.assistantMessage).toBe('A');
  });

  it('throws when the stream ends with an error event', async () => {
    mockFetchOnce(
      new Response(
        sseStream([
          sseChunk('activity', { kind: 'model_change', model: 'claude-sonnet-5' }),
          sseChunk('error', {
            kind: 'error',
            code: 'rate_limited',
            message: 'anthropic_429_rate_limit_error',
          }),
        ]),
        { status: 200 },
      ),
    );
    const adapter = makeAdapter();
    await expect(adapter.generatePatch({ doc: makeDoc() }, 'x')).rejects.toThrow(
      /rate_limited/,
    );
  });

  it('throws when the fetch response is non-2xx', async () => {
    mockFetchOnce(
      new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const adapter = makeAdapter();
    await expect(adapter.generatePatch({ doc: makeDoc() }, 'x')).rejects.toThrow(
      /status=404 code=not_found/,
    );
  });

  it('throws when the stream ends without done or error', async () => {
    mockFetchOnce(new Response(sseStream([]), { status: 200 }));
    const adapter = makeAdapter();
    await expect(adapter.generatePatch({ doc: makeDoc() }, 'x')).rejects.toThrow(
      /without done or error/,
    );
  });

  it('throws when there is no active session', async () => {
    const noSessionClient = {
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
      },
    } as unknown as SupabaseClient;

    const adapter = new ClaudeAIAdapter({
      client: noSessionClient,
      projectDocumentId: DOC_ID,
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: ANON_KEY,
    });
    await expect(adapter.generatePatch({ doc: makeDoc() }, 'x')).rejects.toThrow(
      /no active session/,
    );
  });
});

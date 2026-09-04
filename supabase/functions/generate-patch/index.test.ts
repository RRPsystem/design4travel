// Deno-tests voor de streaming generate-patch Edge Function.
//
// Test-strategie: mock callAnthropicStream door een AsyncGenerator te
// injecteren die de gewenste events produceert. De handler bouwt een
// ReadableStream response; we lezen die uit en parsen de SSE-events om
// het gedrag te asserten.

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { makeHandler } from "./handler.ts";
import type {
  AnthropicCallFailure,
  AnthropicStreamEvent,
  AnthropicStreamStart,
} from "./anthropic.ts";

// -----------------------------------------------------------------------------
// Assertion helpers
// -----------------------------------------------------------------------------

function eq<T>(actual: T, expected: T, msg?: string): void {
  const sa = JSON.stringify(actual);
  const se = JSON.stringify(expected);
  if (sa !== se) {
    throw new Error(`assertion failed${msg ? ` (${msg})` : ""}: got ${sa} expected ${se}`);
  }
}
function isTrue(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const DOC_UUID = "22222222-2222-2222-2222-222222222222";
const PROJECT_UUID = "33333333-3333-3333-3333-333333333333";
const ORG_UUID = "44444444-4444-4444-4444-444444444444";
const USER_UUID = "55555555-5555-5555-5555-555555555555";
const CONTENT_SOURCE_UUID = "66666666-6666-4666-8666-666666666666";

const OK_DOC = {
  version: "0.1.0",
  project: { documentType: "website", title: "Current" },
  pages: [{ id: "p1", root: { id: "r", type: "layout-column", props: {} } }],
};

const DOC_WITH_SOURCE = {
  version: "0.1.0",
  project: {
    documentType: "website",
    title: "Current",
    contentSourceId: CONTENT_SOURCE_UUID,
  },
  pages: [{ id: "p1", root: { id: "r", type: "layout-column", props: {} } }],
};

const MOCK_TRAVEL_CONTENT = {
  schema_version: "1.0",
  title: "Test-reis",
  days: 7,
  countries: ["Marokko"],
  destinations: [{ name: "Marrakech", country: "Marokko" }],
  meta: { source_kind: "fixture" },
};
const OK_BODY = { project_document_id: DOC_UUID, prompt: "maak titel groter" };
const OK_USER: User = {
  id: USER_UUID,
  aud: "authenticated",
  role: "authenticated",
  app_metadata: {},
  user_metadata: {},
  email: "u@example.local",
  created_at: "2026-01-01T00:00:00Z",
} as unknown as User;

// -----------------------------------------------------------------------------
// Stub-builders
// -----------------------------------------------------------------------------

interface Spy {
  anthropicCalls: number;
  metricInserts: Array<Record<string, unknown>>;
  metricInsertShouldFail: boolean;
  contentSourcesLoadCount: number;
}
function newSpy(): Spy {
  return {
    anthropicCalls: 0,
    metricInserts: [],
    metricInsertShouldFail: false,
    contentSourcesLoadCount: 0,
  };
}

interface UserClientOpts {
  docExists?: boolean;
  docHasContentSource?: boolean;
  contentSourceVisible?: boolean;
}

function makeUserClient(spy: Spy, opts: UserClientOpts = {}) {
  return (_jwt: string) =>
    ({
      auth: {
        getUser: async () => ({ data: { user: OK_USER }, error: null }),
      },
      from: (table: string) => {
        const stub = {
          select: () => stub,
          eq: () => stub,
          maybeSingle: async () => {
            if (table === "project_documents") {
              if (opts.docExists === false) return { data: null, error: null };
              const doc = opts.docHasContentSource ? DOC_WITH_SOURCE : OK_DOC;
              return { data: { doc, project_id: PROJECT_UUID }, error: null };
            }
            if (table === "projects") {
              return { data: { organization_id: ORG_UUID }, error: null };
            }
            if (table === "content_sources") {
              spy.contentSourcesLoadCount += 1;
              if (opts.contentSourceVisible === false) return { data: null, error: null };
              return { data: { content: MOCK_TRAVEL_CONTENT }, error: null };
            }
            return { data: null, error: null };
          },
        };
        return stub;
      },
    }) as unknown as SupabaseClient;
}

function makeAdmin(spy: Spy) {
  return () =>
    ({
      from: (_table: string) => {
        const stub = {
          insert: (row: Record<string, unknown>) => {
            spy.metricInserts.push(row);
            const chain = {
              select: () => chain,
              maybeSingle: async () =>
                spy.metricInsertShouldFail
                  ? { data: null, error: { message: "boom" } }
                  : { data: { id: `metric-${spy.metricInserts.length}` }, error: null },
            };
            return chain;
          },
        };
        return stub;
      },
    }) as unknown as SupabaseClient;
}

/** Async-generator vanuit een array — voor de mock-stream. */
async function* fromEvents(
  events: AnthropicStreamEvent[],
): AsyncGenerator<AnthropicStreamEvent, void, void> {
  for (const e of events) yield e;
}

interface StreamScript {
  router?: AnthropicStreamStart | AnthropicCallFailure;
  specialist?: AnthropicStreamStart | AnthropicCallFailure;
}

function makeCallStream(spy: Spy, script: StreamScript) {
  let callIndex = 0;
  return async function () {
    spy.anthropicCalls += 1;
    const isRouter = callIndex === 0;
    callIndex += 1;
    const impl = isRouter ? script.router : script.specialist;
    if (!impl) throw new Error(`no anthropic-mock for ${isRouter ? "router" : "specialist"}`);
    return impl;
  };
}

function okStream(
  events: AnthropicStreamEvent[],
  requestId = "req_test",
): AnthropicStreamStart {
  return {
    ok: true,
    events: fromEvents(events),
    requestId,
    startedAt: 1_735_000_000_000,
  };
}

function failStream(status: number, errorCode: string): AnthropicCallFailure {
  return { ok: false, status, errorCode, latencyMs: 12, requestId: null };
}

function makeDeps(
  spy: Spy,
  script: StreamScript,
  opts: {
    docExists?: boolean;
    apiKey?: string | null;
    docHasContentSource?: boolean;
    contentSourceVisible?: boolean;
  } = {},
) {
  return {
    makeUserClient: makeUserClient(spy, {
      docExists: opts.docExists,
      docHasContentSource: opts.docHasContentSource,
      contentSourceVisible: opts.contentSourceVisible,
    }),
    makeAdmin: makeAdmin(spy),
    getAnthropicApiKey: () => (opts.apiKey === undefined ? "sk-test" : opts.apiKey),
    getOrchestratorModel: () => "claude-sonnet-5",
    getSpecialistModel: () => "claude-opus-5",
    getBetaHeaders: () => null,
    now: () => 1_735_000_001_000,
    callAnthropicStream: makeCallStream(spy, script),
  };
}

function makeReq(body: unknown, opts: { auth?: string | null; method?: string } = {}): Request {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== null) headers.authorization = opts.auth ?? "Bearer test-jwt";
  return new Request("https://x.local/generate-patch", {
    method: opts.method ?? "POST",
    headers,
    body: bodyText,
  });
}

/** Read all SSE events from a streaming response into a typed array. */
async function readSSE(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const out: Array<{ event: string; data: unknown }> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let eventName = "";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (!eventName || dataLines.length === 0) continue;
      out.push({ event: eventName, data: JSON.parse(dataLines.join("\n")) });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

Deno.test("405 on GET (pre-stream error)", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps(spy, {}));
  const res = await h(new Request("https://x.local/", { method: "GET" }));
  eq(res.status, 405);
});

Deno.test("401 on missing authorization (pre-stream error)", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps(spy, {}));
  const res = await h(makeReq(OK_BODY, { auth: null }));
  eq(res.status, 401);
});

Deno.test("400 on schema-invalid body (pre-stream)", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps(spy, {}));
  const res = await h(makeReq({ project_document_id: "not-a-uuid", prompt: "hi" }));
  eq(res.status, 400);
});

Deno.test("404 when doc not visible under RLS (pre-stream)", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps(spy, {}, { docExists: false }));
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 404);
});

Deno.test("happy path — sonnet-only stream produces activity + done events + 1 metric", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(spy, {
      router: okStream([
        { kind: "text_delta", text: "OK, " },
        { kind: "text_delta", text: "gedaan." },
        { kind: "tool_start", index: 0, id: "tu1", name: "set_prop" },
        {
          kind: "tool_complete",
          index: 0,
          id: "tu1",
          name: "set_prop",
          input: { nodeId: "hero", key: "titleFontSize", value: 66 },
        },
        { kind: "usage", usage: { input_tokens: 120, output_tokens: 40 } },
        { kind: "message_stop" },
      ]),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 200);
  eq(res.headers.get("content-type"), "text/event-stream; charset=utf-8");

  const events = await readSSE(res);
  // model_change + 2 text_delta + tool_start + tool_complete + done
  const kinds = events.map((e) => `${e.event}:${(e.data as { kind: string }).kind}`);
  eq(kinds.includes("activity:model_change"), true);
  eq(kinds.filter((k) => k === "activity:text_delta").length, 2);
  eq(kinds.includes("activity:tool_start"), true);
  eq(kinds.includes("activity:tool_complete"), true);

  const done = events.find((e) => e.event === "done")!.data as {
    assistantMessage: string;
    patches: Array<{ kind: string }>;
  };
  eq(done.assistantMessage, "OK, gedaan.");
  eq(done.patches.length, 1);
  eq(done.patches[0]!.kind, "setProp");

  // Metrics: 1 router-rij met token-counts uit de usage-event.
  eq(spy.metricInserts.length, 1);
  const m = spy.metricInserts[0]!;
  eq(m.kind, "router");
  eq(m.success, true);
  eq(m.input_tokens, 120);
  eq(m.output_tokens, 40);
});

Deno.test("delegate path — Sonnet emits delegate_to_opus, Opus streams patches, 2 metrics linked", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(spy, {
      router: okStream([
        {
          kind: "tool_start",
          index: 0,
          id: "tu_del",
          name: "delegate_to_opus",
        },
        {
          kind: "tool_complete",
          index: 0,
          id: "tu_del",
          name: "delegate_to_opus",
          input: {
            enriched_prompt: "Redesign the hero for luxury feel",
            rationale: "Vague creative ask",
          },
        },
        { kind: "usage", usage: { input_tokens: 500, output_tokens: 30 } },
        { kind: "message_stop" },
      ]),
      specialist: okStream([
        { kind: "text_delta", text: "Klaar." },
        {
          kind: "tool_start",
          index: 0,
          id: "tu_p",
          name: "set_props",
        },
        {
          kind: "tool_complete",
          index: 0,
          id: "tu_p",
          name: "set_props",
          input: {
            nodeId: "hero",
            props: { title: "Ontdek Luxe", overlay: true, height: 640 },
          },
        },
        { kind: "usage", usage: { input_tokens: 800, output_tokens: 200 } },
        { kind: "message_stop" },
      ]),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 200);

  const events = await readSSE(res);
  // Delegate-event moet erin zitten.
  const delegate = events.find(
    (e) => e.event === "activity" && (e.data as { kind: string }).kind === "delegate",
  );
  isTrue(!!delegate, "delegate event emitted");

  const done = events.find((e) => e.event === "done")!.data as {
    assistantMessage: string;
    patches: Array<{ kind: string }>;
  };
  eq(done.assistantMessage, "Klaar.");
  eq(done.patches.length, 1);
  eq(done.patches[0]!.kind, "setProps");

  // 2 metrics, tweede heeft parent_call_id = eerste's id.
  eq(spy.metricInserts.length, 2);
  eq(spy.metricInserts[0]!.kind, "router");
  eq(spy.metricInserts[1]!.kind, "specialist");
  eq(spy.metricInserts[1]!.parent_call_id, "metric-1");
  eq(spy.metricInserts[1]!.model, "claude-opus-5");
});

Deno.test("Anthropic 429 on router → error event + 429-status metric", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(spy, {
      router: failStream(429, "anthropic_429_rate_limit_error"),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 200); // stream started; error event is inside the stream

  const events = await readSSE(res);
  const err = events.find((e) => e.event === "error");
  isTrue(!!err, "error event emitted");
  eq((err!.data as { code: string }).code, "rate_limited");

  eq(spy.metricInserts.length, 1);
  eq(spy.metricInserts[0]!.success, false);
  eq(spy.metricInserts[0]!.error_code, "anthropic_429_rate_limit_error");
});

Deno.test("metric insert failure NOT fatal — done event still arrives", async () => {
  const spy = newSpy();
  spy.metricInsertShouldFail = true;
  const h = makeHandler(
    makeDeps(spy, {
      router: okStream([
        { kind: "text_delta", text: "OK" },
        {
          kind: "tool_start",
          index: 0,
          id: "tu",
          name: "set_prop",
        },
        {
          kind: "tool_complete",
          index: 0,
          id: "tu",
          name: "set_prop",
          input: { nodeId: "hero", key: "title", value: "X" },
        },
        { kind: "usage", usage: { input_tokens: 50, output_tokens: 10 } },
        { kind: "message_stop" },
      ]),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  const events = await readSSE(res);
  const done = events.find((e) => e.event === "done");
  isTrue(!!done, "done event still arrives despite metric-insert failure");
});

// -----------------------------------------------------------------------------
// PR-2: content_sources loading path
// -----------------------------------------------------------------------------

Deno.test("content_sources NOT queried when doc has no contentSourceId", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(spy, {
      router: okStream([
        { kind: "text_delta", text: "ok" },
        { kind: "usage", usage: { input_tokens: 10, output_tokens: 5 } },
        { kind: "message_stop" },
      ]),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  const events = await readSSE(res);
  isTrue(!!events.find((e) => e.event === "done"), "stream completes");
  eq(spy.contentSourcesLoadCount, 0);
});

Deno.test("content_sources queried once when doc has contentSourceId", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(
      spy,
      {
        router: okStream([
          { kind: "text_delta", text: "ok" },
          { kind: "usage", usage: { input_tokens: 10, output_tokens: 5 } },
          { kind: "message_stop" },
        ]),
      },
      { docHasContentSource: true },
    ),
  );
  const res = await h(makeReq(OK_BODY));
  const events = await readSSE(res);
  isTrue(!!events.find((e) => e.event === "done"), "stream completes");
  eq(spy.contentSourcesLoadCount, 1);
});

Deno.test("stream still completes when contentSourceId points to invisible row (fail-safe)", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(
      spy,
      {
        router: okStream([
          { kind: "text_delta", text: "ok" },
          { kind: "usage", usage: { input_tokens: 10, output_tokens: 5 } },
          { kind: "message_stop" },
        ]),
      },
      { docHasContentSource: true, contentSourceVisible: false },
    ),
  );
  const res = await h(makeReq(OK_BODY));
  const events = await readSSE(res);
  // Fail-safe: geen error event, done arriveert normaal, AI werkt zonder context.
  isTrue(!events.find((e) => e.event === "error"), "no error emitted");
  isTrue(!!events.find((e) => e.event === "done"), "done event still arrives");
  eq(spy.contentSourcesLoadCount, 1);
});

// -----------------------------------------------------------------------------
// PR-1 (live-preview): tool_complete carries `patch` field for known tools
// -----------------------------------------------------------------------------

Deno.test("tool_complete for known tool carries populated `patch` field", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(spy, {
      router: okStream([
        { kind: "tool_start", index: 0, id: "tu1", name: "set_prop" },
        {
          kind: "tool_complete",
          index: 0,
          id: "tu1",
          name: "set_prop",
          input: { nodeId: "hero", key: "titleFontSize", value: 66 },
        },
        { kind: "usage", usage: { input_tokens: 10, output_tokens: 5 } },
        { kind: "message_stop" },
      ]),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  const events = await readSSE(res);
  const tc = events.find(
    (e) => e.event === "activity" && (e.data as { kind: string }).kind === "tool_complete",
  );
  isTrue(!!tc, "tool_complete event emitted");
  const data = tc!.data as { patch: { kind: string; nodeId: string; key: string; value: unknown } | null };
  isTrue(data.patch !== null, "patch should be present for known tool");
  eq(data.patch!.kind, "setProp");
  eq(data.patch!.nodeId, "hero");
  eq(data.patch!.key, "titleFontSize");
  eq(data.patch!.value, 66);
});

Deno.test("tool_complete for delegate_to_opus carries `patch: null`", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(spy, {
      router: okStream([
        { kind: "tool_start", index: 0, id: "tu_del", name: "delegate_to_opus" },
        {
          kind: "tool_complete",
          index: 0,
          id: "tu_del",
          name: "delegate_to_opus",
          input: { enriched_prompt: "bouw een pagina X", rationale: "grote scope" },
        },
        { kind: "usage", usage: { input_tokens: 10, output_tokens: 5 } },
        { kind: "message_stop" },
      ]),
      // Zonder specialist-script zou de handler crashen zodra hij delegate detecteert;
      // we voegen een minimal specialist-stream toe die niets doet.
      specialist: okStream([
        { kind: "usage", usage: { input_tokens: 5, output_tokens: 5 } },
        { kind: "message_stop" },
      ]),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  const events = await readSSE(res);
  const tc = events.find(
    (e) =>
      e.event === "activity" &&
      (e.data as { kind: string; tool?: string }).kind === "tool_complete" &&
      (e.data as { tool?: string }).tool === "delegate_to_opus",
  );
  isTrue(!!tc, "tool_complete event emitted for delegate");
  const data = tc!.data as { patch: unknown };
  eq(data.patch, null);
});

Deno.test("tool_complete for tool with invalid input carries `patch: null`", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(spy, {
      router: okStream([
        { kind: "tool_start", index: 0, id: "tu1", name: "set_prop" },
        {
          kind: "tool_complete",
          index: 0,
          id: "tu1",
          name: "set_prop",
          input: { /* mist required nodeId/key/value */ } as Record<string, unknown>,
        },
        { kind: "usage", usage: { input_tokens: 10, output_tokens: 5 } },
        { kind: "message_stop" },
      ]),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  const events = await readSSE(res);
  const tc = events.find(
    (e) => e.event === "activity" && (e.data as { kind: string }).kind === "tool_complete",
  );
  isTrue(!!tc, "tool_complete event still emitted");
  const data = tc!.data as { patch: unknown };
  eq(data.patch, null);
});

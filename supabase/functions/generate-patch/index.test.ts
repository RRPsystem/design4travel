// Deno-tests voor generate-patch.
//
// Focus: unieke gedragingen van deze functie — router-only-pad,
// delegate-pad, Anthropic-error-mapping, fail-open metrics. Basispaden
// (method, body-size, JWT) worden minimaal getest omdat het patroon
// identiek is aan de andere Edge Functions.

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { makeHandler } from "./handler.ts";
import type {
  AnthropicCallFailure,
  AnthropicCallResult,
} from "./anthropic.ts";

// ---- Assert helpers ---------------------------------------------------------

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

// ---- Fixtures ---------------------------------------------------------------

const DOC_UUID = "22222222-2222-2222-2222-222222222222";
const PROJECT_UUID = "33333333-3333-3333-3333-333333333333";
const ORG_UUID = "44444444-4444-4444-4444-444444444444";
const USER_UUID = "55555555-5555-5555-5555-555555555555";

const OK_DOC = {
  version: "0.1.0",
  project: { documentType: "website", title: "Current" },
  pages: [{ id: "p1", root: { id: "r", type: "layout-column", props: {} } }],
};

const OK_BODY = {
  project_document_id: DOC_UUID,
  prompt: "maak de titel groter",
};

const OK_USER: User = {
  id: USER_UUID,
  aud: "authenticated",
  role: "authenticated",
  app_metadata: {},
  user_metadata: {},
  email: "u@example.local",
  created_at: "2026-01-01T00:00:00Z",
} as unknown as User;

// ---- Client + call stubs ----------------------------------------------------

interface Spy {
  anthropicCalls: number;
  metricInserts: Array<Record<string, unknown>>;
  metricInsertShouldFail: boolean;
}

function newSpy(): Spy {
  return {
    anthropicCalls: 0,
    metricInserts: [],
    metricInsertShouldFail: false,
  };
}

interface CallSnapshot {
  userText: string;
  messages: Array<{ role: string; content: string }>;
  model: string;
}

interface AnthropicScript {
  router?: (snap: CallSnapshot) => AnthropicCallResult | AnthropicCallFailure;
  specialist?: (snap: CallSnapshot) => AnthropicCallResult | AnthropicCallFailure;
}

function makeAnthropicCall(spy: Spy, script: AnthropicScript) {
  let callIndex = 0;
  return async function (input: {
    messages: Array<{ role: string; content: string }>;
    model: string;
  }) {
    spy.anthropicCalls += 1;
    const isRouter = callIndex === 0;
    callIndex += 1;
    const impl = isRouter ? script.router : script.specialist;
    if (!impl) throw new Error(`no anthropic-mock for ${isRouter ? "router" : "specialist"}`);
    const last = input.messages[input.messages.length - 1];
    const snap: CallSnapshot = {
      userText: last?.content ?? "",
      messages: input.messages,
      model: input.model,
    };
    return impl(snap);
  };
}

function successResponse(overrides: {
  content: Array<Record<string, unknown>>;
  usage?: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    thinking_tokens: number;
  }>;
}): AnthropicCallResult {
  return {
    ok: true,
    response: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: overrides.content as never,
      stop_reason: "end_turn",
      usage: {
        input_tokens: overrides.usage?.input_tokens ?? 100,
        output_tokens: overrides.usage?.output_tokens ?? 50,
        cache_read_input_tokens: overrides.usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: overrides.usage?.cache_creation_input_tokens ?? 0,
        thinking_tokens: overrides.usage?.thinking_tokens ?? 0,
      },
    },
    latencyMs: 123,
    requestId: "req_test",
  };
}

function failureResponse(status: number, errorCode: string): AnthropicCallFailure {
  return { ok: false, status, errorCode, latencyMs: 45, requestId: null };
}

function makeUserClient(spy: Spy, opts: { user?: User | null; docExists?: boolean } = {}) {
  return (_jwt: string) => ({
    auth: {
      getUser: async () => ({
        data: { user: opts.user === undefined ? OK_USER : opts.user },
        error: null,
      }),
    },
    from: (table: string) => {
      const stub = {
        select: () => stub,
        eq: () => stub,
        maybeSingle: async () => {
          if (table === "project_documents") {
            if (opts.docExists === false) return { data: null, error: null };
            return { data: { doc: OK_DOC, project_id: PROJECT_UUID }, error: null };
          }
          if (table === "projects") {
            return { data: { organization_id: ORG_UUID }, error: null };
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

function makeReq(body: unknown, opts: { auth?: string; method?: string } = {}): Request {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://x.local/generate-patch", {
    method: opts.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.auth === null ? {} : { authorization: opts.auth ?? "Bearer test-jwt" }),
    },
    body: bodyText,
  });
}

function makeDeps(spy: Spy, script: AnthropicScript, opts: { docExists?: boolean; apiKey?: string | null } = {}) {
  return {
    makeUserClient: makeUserClient(spy, opts.docExists === false ? { docExists: false } : {}),
    makeAdmin: makeAdmin(spy),
    getAnthropicApiKey: () => (opts.apiKey === undefined ? "sk-test" : opts.apiKey),
    getOrchestratorModel: () => "claude-sonnet-5",
    getSpecialistModel: () => "claude-opus-5",
    getBetaHeaders: () => null,
    now: () => 1_735_000_000_000,
    callAnthropic: makeAnthropicCall(spy, script),
  };
}

// ---- Tests ------------------------------------------------------------------

Deno.test("405 on GET", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps(spy, {}));
  const res = await h(new Request("https://x.local/", { method: "GET" }));
  eq(res.status, 405);
});

Deno.test("401 on missing authorization", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps(spy, {}));
  const req = new Request("https://x.local/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(OK_BODY),
  });
  const res = await h(req);
  eq(res.status, 401);
  eq((await res.json()).error, "missing_authorization");
});

Deno.test("400 on invalid_json", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps(spy, {}));
  const res = await h(makeReq("this-is-not-json"));
  eq(res.status, 400);
  eq((await res.json()).error, "invalid_json");
});

Deno.test("400 on schema-invalid body", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps(spy, {}));
  const res = await h(makeReq({ project_document_id: "not-a-uuid", prompt: "hi" }));
  eq(res.status, 400);
  eq((await res.json()).error, "invalid_request");
});

Deno.test("500 when ANTHROPIC_API_KEY missing", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps(spy, {}, { apiKey: null }));
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 500);
  eq((await res.json()).error, "internal_error");
});

Deno.test("404 when doc not found", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps(spy, {}, { docExists: false }));
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 404);
  eq((await res.json()).error, "not_found");
});

Deno.test("happy path — sonnet-only (no delegate) returns patches + 1 metric row", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(spy, {
      router: () =>
        successResponse({
          content: [
            { type: "text", text: "Hero-titel op 66px gezet." },
            {
              type: "tool_use",
              id: "tu_1",
              name: "set_prop",
              input: { nodeId: "hero", key: "titleFontSize", value: 66 },
            },
          ],
        }),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 200);
  const body = (await res.json()) as { assistantMessage: string; patches: unknown[] };
  eq(body.assistantMessage, "Hero-titel op 66px gezet.");
  eq(body.patches.length, 1);
  eq((body.patches[0] as { kind: string }).kind, "setProp");

  eq(spy.anthropicCalls, 1);
  eq(spy.metricInserts.length, 1);
  const m = spy.metricInserts[0]! as Record<string, unknown>;
  eq(m.kind, "router");
  eq(m.parent_call_id, null);
  eq(m.success, true);
  eq(m.user_id, USER_UUID);
  eq(m.organization_id, ORG_UUID);
  eq(m.model, "claude-sonnet-5");
  isTrue((m.input_tokens as number) > 0, "input_tokens counted");
});

Deno.test("delegate path — router emits delegate_to_opus, specialist runs, patches come from Opus, 2 metric rows share parent_call_id", async () => {
  const spy = newSpy();

  const routerResp = successResponse({
    content: [
      {
        type: "tool_use",
        id: "tu_delegate",
        name: "delegate_to_opus",
        input: {
          enriched_prompt: "Redesign the hero for a luxury feel.",
          rationale: "Vague creative ask requiring judgement",
        },
      },
    ],
  });

  const opusResp = successResponse({
    content: [
      { type: "text", text: "Hero herontworpen." },
      {
        type: "tool_use",
        id: "tu_ins",
        name: "set_props",
        input: { nodeId: "hero", props: { title: "Ontdek Luxe", overlay: true, height: 640 } },
      },
    ],
    usage: { input_tokens: 500, output_tokens: 200 },
  });

  const h = makeHandler(
    makeDeps(spy, {
      router: () => routerResp,
      specialist: (snap) => {
        // Verifieer dat Opus de enriched_prompt kreeg, niet de originele prompt.
        isTrue(snap.userText.includes("Redesign the hero"), "opus receives enriched_prompt");
        return opusResp;
      },
    }),
  );

  const res = await h(makeReq(OK_BODY));
  eq(res.status, 200);
  const body = (await res.json()) as { assistantMessage: string; patches: unknown[] };
  eq(body.assistantMessage, "Hero herontworpen.");
  eq(body.patches.length, 1);
  eq((body.patches[0] as { kind: string }).kind, "setProps");

  eq(spy.anthropicCalls, 2);
  eq(spy.metricInserts.length, 2);
  const [routerMetric, specialistMetric] = spy.metricInserts as [
    Record<string, unknown>,
    Record<string, unknown>,
  ];
  eq(routerMetric.kind, "router");
  eq(routerMetric.parent_call_id, null);
  eq(specialistMetric.kind, "specialist");
  eq(specialistMetric.parent_call_id, "metric-1");
  eq(specialistMetric.model, "claude-opus-5");
  eq(specialistMetric.route_reason, "Vague creative ask requiring judgement");
});

Deno.test("multi-turn: history in body is forwarded to Anthropic as prior messages", async () => {
  const spy = newSpy();
  let capturedMessages: Array<{ role: string; content: string }> = [];
  const h = makeHandler(
    makeDeps(spy, {
      router: (snap) => {
        capturedMessages = snap.messages;
        return successResponse({
          content: [
            { type: "text", text: "OK." },
            { type: "tool_use", id: "tu", name: "set_prop", input: { nodeId: "hero", key: "title", value: "X" } },
          ],
        });
      },
    }),
  );
  const bodyWithHistory = {
    ...OK_BODY,
    history: [
      { role: "user", content: "eerste vraag" },
      { role: "assistant", content: "eerste antwoord" },
      { role: "user", content: "tweede vraag" },
      { role: "assistant", content: "tweede antwoord" },
    ],
  };
  const res = await h(makeReq(bodyWithHistory));
  eq(res.status, 200);
  // 4 history-messages + 1 current prompt = 5 total, in volgorde.
  eq(capturedMessages.length, 5);
  eq(capturedMessages[0]!.role, "user");
  eq(capturedMessages[0]!.content, "eerste vraag");
  eq(capturedMessages[4]!.role, "user");
  eq(capturedMessages[4]!.content, OK_BODY.prompt);
});

Deno.test("page-ops: add_page tool_use maps to addPage PatchOp", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(spy, {
      router: () =>
        successResponse({
          content: [
            { type: "text", text: "Golfpagina toegevoegd." },
            {
              type: "tool_use",
              id: "tu_ap",
              name: "add_page",
              input: {
                page: {
                  id: "page-golf",
                  name: "Golfreis",
                  root: { id: "golf-root", type: "layout-column", props: {} },
                },
              },
            },
          ],
        }),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 200);
  const body = (await res.json()) as { patches: Array<{ kind: string }> };
  eq(body.patches.length, 1);
  eq(body.patches[0]!.kind, "addPage");
});

Deno.test("Anthropic 429 on router → 429 rate_limited, no specialist call", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(spy, {
      router: () => failureResponse(429, "anthropic_429_rate_limit_error"),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 429);
  eq((await res.json()).error, "rate_limited");
  eq(spy.anthropicCalls, 1);
  eq(spy.metricInserts.length, 1);
  eq(spy.metricInserts[0]!.success, false);
});

Deno.test("Anthropic 503 on router → 502 upstream_unavailable", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(spy, {
      router: () => failureResponse(503, "anthropic_503_overloaded"),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 502);
  eq((await res.json()).error, "upstream_unavailable");
});

Deno.test("metric insert failure NOT fatal — AI response still 200", async () => {
  const spy = newSpy();
  spy.metricInsertShouldFail = true;
  const h = makeHandler(
    makeDeps(spy, {
      router: () =>
        successResponse({
          content: [
            { type: "text", text: "OK" },
            { type: "tool_use", id: "tu_1", name: "set_prop", input: { nodeId: "hero", key: "title", value: "X" } },
          ],
        }),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 200);
  const body = (await res.json()) as { patches: unknown[] };
  eq(body.patches.length, 1);
});

Deno.test("Opus re-delegate attempt is ignored (specialist tools exclude delegate)", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(spy, {
      router: () =>
        successResponse({
          content: [
            { type: "tool_use", id: "tu_del", name: "delegate_to_opus", input: { enriched_prompt: "do it", rationale: "why" } },
          ],
        }),
      // Opus emit's een delegate_to_opus — moet worden genegeerd
      specialist: () =>
        successResponse({
          content: [
            { type: "text", text: "Klaar." },
            {
              type: "tool_use",
              id: "tu_re",
              name: "delegate_to_opus",
              input: { enriched_prompt: "again", rationale: "loop" },
            },
            { type: "tool_use", id: "tu_p", name: "set_prop", input: { nodeId: "x", key: "y", value: "z" } },
          ],
        }),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 200);
  const body = (await res.json()) as { patches: unknown[] };
  eq(body.patches.length, 1);
  eq((body.patches[0] as { kind: string }).kind, "setProp");
});

Deno.test("invalid tool_use input is dropped (not treated as valid patch)", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps(spy, {
      router: () =>
        successResponse({
          content: [
            { type: "text", text: "Hm." },
            // ontbrekende 'value' — schema.safeParse zou moeten falen
            { type: "tool_use", id: "tu_bad", name: "set_prop", input: { nodeId: "x", key: "y" } },
          ],
        }),
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 200);
  const body = (await res.json()) as { patches: unknown[] };
  eq(body.patches.length, 0);
});

// ---- CORS + method smoke ----------------------------------------------------

Deno.test("OPTIONS → 204 with CORS", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps(spy, {}));
  const res = await h(new Request("https://x.local/", { method: "OPTIONS" }));
  eq(res.status, 204);
  isTrue(res.headers.get("access-control-allow-origin") === "*", "CORS present");
});

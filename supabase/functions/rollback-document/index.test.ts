import type { SupabaseClient, User } from "@supabase/supabase-js";
import { makeHandler } from "./handler.ts";
import {
  CORS_HEADERS,
  MAX_REQUEST_BODY_BYTES,
  mapRpcError,
  PG_INT_MAX,
  RollbackRequestSchema,
  RollbackResponseSchema,
} from "./schema.ts";

// ---- Minimal assertion helpers (no external deps) ----------------------
function eq<T>(actual: T, expected: T, msg?: string): void {
  const sa = JSON.stringify(actual);
  const se = JSON.stringify(expected);
  if (sa !== se) {
    throw new Error(
      `assertion failed${msg ? ` (${msg})` : ""}: got ${sa} expected ${se}`,
    );
  }
}
function isTrue(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ---- Test fixtures -----------------------------------------------------
const OK_UUID = "11111111-1111-1111-1111-111111111111";
const OTHER_UUID = "22222222-2222-2222-2222-222222222222";
const OK_BODY = {
  project_document_id: OK_UUID,
  target_version_number: 3,
  expected_lock_version: 2,
};

interface RpcCall {
  name: string;
  params: Record<string, unknown>;
}

interface Spy {
  makeUserClientCalls: number;
  makeAdminCalls: number;
  getUserCalls: string[];
  rpcCalls: RpcCall[];
}
function newSpy(): Spy {
  return {
    makeUserClientCalls: 0,
    makeAdminCalls: 0,
    getUserCalls: [],
    rpcCalls: [],
  };
}

interface StubOpts {
  spy: Spy;
  getUserResult?: () => Promise<
    { data: { user: User | null }; error: unknown | null }
  >;
  getUserThrows?: () => never;
  rpcResult?: () => Promise<{ data: unknown; error: unknown }>;
  rpcThrows?: () => never;
  makeUserClientThrows?: boolean;
  makeAdminThrows?: boolean;
}

function makeDeps(opts: StubOpts) {
  return {
    makeUserClient(): SupabaseClient {
      opts.spy.makeUserClientCalls += 1;
      if (opts.makeUserClientThrows) throw new Error("stub_make_user_client");
      const client = {
        auth: {
          getUser: async (jwt2: string) => {
            opts.spy.getUserCalls.push(jwt2);
            if (opts.getUserThrows) opts.getUserThrows();
            if (opts.getUserResult) return await opts.getUserResult();
            return { data: { user: null }, error: null };
          },
        },
      };
      return client as unknown as SupabaseClient;
    },
    makeAdmin(): SupabaseClient {
      opts.spy.makeAdminCalls += 1;
      if (opts.makeAdminThrows) throw new Error("stub_make_admin");
      const client = {
        rpc: async (name: string, params: Record<string, unknown>) => {
          opts.spy.rpcCalls.push({ name, params });
          if (opts.rpcThrows) opts.rpcThrows();
          if (opts.rpcResult) return await opts.rpcResult();
          return { data: null, error: null };
        },
      };
      return client as unknown as SupabaseClient;
    },
  };
}

function mkUser(overrides: Partial<User> = {}): User {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    aud: "authenticated",
    role: "authenticated",
    email: "u@example.local",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as User;
}

function postReq(
  body: unknown,
  opts: { auth?: string | null } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) {
    headers.set("authorization", opts.auth ?? "Bearer valid.jwt.token");
  }
  return new Request("http://local/", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Build a request whose body is delivered via a ReadableStream. No
// Content-Length is auto-set by Deno for stream bodies.
function streamReq(
  bytes: Uint8Array,
  opts: { auth?: string; contentLength?: string | null } = {},
): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const chunkSize = 512;
      let sent = 0;
      while (sent < bytes.byteLength) {
        const end = Math.min(sent + chunkSize, bytes.byteLength);
        controller.enqueue(bytes.slice(sent, end));
        sent = end;
      }
      controller.close();
    },
  });
  const headers = new Headers({
    "content-type": "application/json",
    "authorization": opts.auth ?? "Bearer valid.jwt.token",
  });
  if (opts.contentLength !== undefined && opts.contentLength !== null) {
    headers.set("content-length", opts.contentLength);
  }
  // deno-lint-ignore no-explicit-any
  return new Request("http://local/", {
    method: "POST",
    headers,
    body: stream,
    // duplex is required by the fetch spec when body is a stream
    // deno-lint-ignore no-explicit-any
    ...({ duplex: "half" } as any),
  });
}

// Build a JSON body of exactly `targetBytes` bytes, containing the canonical
// three fields plus a padding key. Valid JSON, but zod.strict() rejects the
// pad key — useful to prove that size-gate passed AND downstream code ran.
function buildExactSizeJson(targetBytes: number): string {
  const base = { ...OK_BODY };
  const opening = JSON.stringify(base).slice(0, -1); // strip closing '}'
  const suffix = '"}';
  const key = ',"pad":"';
  const overhead = opening.length + key.length + suffix.length;
  const padLen = targetBytes - overhead;
  if (padLen < 0) throw new Error("targetBytes too small");
  return opening + key + "x".repeat(padLen) + suffix;
}

async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ============================================================
// 1) Zod: RollbackRequestSchema
// ============================================================
Deno.test("request-schema: valid input", () => {
  const p = RollbackRequestSchema.safeParse(OK_BODY);
  isTrue(p.success, "should accept canonical request");
});
Deno.test("request-schema: missing project_document_id", () => {
  const p = RollbackRequestSchema.safeParse({
    target_version_number: 1,
    expected_lock_version: 0,
  });
  isTrue(!p.success, "should reject missing id");
});
Deno.test("request-schema: non-uuid id", () => {
  const p = RollbackRequestSchema.safeParse({ ...OK_BODY, project_document_id: "nope" });
  isTrue(!p.success, "should reject non-uuid");
});
Deno.test("request-schema: target_version_number = 0", () => {
  const p = RollbackRequestSchema.safeParse({ ...OK_BODY, target_version_number: 0 });
  isTrue(!p.success, "positive-only");
});
Deno.test("request-schema: target_version_number = -1", () => {
  const p = RollbackRequestSchema.safeParse({ ...OK_BODY, target_version_number: -1 });
  isTrue(!p.success, "positive-only");
});
Deno.test("request-schema: expected_lock_version = -1", () => {
  const p = RollbackRequestSchema.safeParse({ ...OK_BODY, expected_lock_version: -1 });
  isTrue(!p.success, "nonneg-only");
});
Deno.test("request-schema: unknown top-level key rejected (strict)", () => {
  const p = RollbackRequestSchema.safeParse({ ...OK_BODY, p_actor_user_id: OK_UUID });
  isTrue(!p.success, "strict must reject body-injection of actor id");
});
Deno.test("request-schema: extra unrelated key rejected (strict)", () => {
  const p = RollbackRequestSchema.safeParse({ ...OK_BODY, extra: "x" });
  isTrue(!p.success, "strict must reject any extra key");
});

// ---- M1: PostgreSQL integer upper bounds -----------------------------
Deno.test("request-schema: target_version_number = PG_INT_MAX accepted", () => {
  const p = RollbackRequestSchema.safeParse({ ...OK_BODY, target_version_number: PG_INT_MAX });
  isTrue(p.success, "PG_INT_MAX must be within range");
});
Deno.test("request-schema: expected_lock_version = PG_INT_MAX accepted", () => {
  const p = RollbackRequestSchema.safeParse({ ...OK_BODY, expected_lock_version: PG_INT_MAX });
  isTrue(p.success, "PG_INT_MAX must be within range");
});
Deno.test("request-schema: target_version_number = PG_INT_MAX + 1 rejected", () => {
  const p = RollbackRequestSchema.safeParse({ ...OK_BODY, target_version_number: PG_INT_MAX + 1 });
  isTrue(!p.success, "overflow must be rejected");
});
Deno.test("request-schema: expected_lock_version = PG_INT_MAX + 1 rejected", () => {
  const p = RollbackRequestSchema.safeParse({ ...OK_BODY, expected_lock_version: PG_INT_MAX + 1 });
  isTrue(!p.success, "overflow must be rejected");
});

// ============================================================
// 2) Zod: RollbackResponseSchema
// ============================================================
Deno.test("response-schema: valid row", () => {
  const p = RollbackResponseSchema.safeParse({
    project_document_id: OK_UUID,
    new_lock_version: 1,
    new_version_number: 2,
  });
  isTrue(p.success, "canonical row must pass");
});
Deno.test("response-schema: missing new_lock_version", () => {
  const p = RollbackResponseSchema.safeParse({
    project_document_id: OK_UUID,
    new_version_number: 2,
  });
  isTrue(!p.success, "missing field must fail");
});
Deno.test("response-schema: new_version_number = 0", () => {
  const p = RollbackResponseSchema.safeParse({
    project_document_id: OK_UUID,
    new_lock_version: 1,
    new_version_number: 0,
  });
  isTrue(!p.success, "must be positive");
});
Deno.test("response-schema: new_lock_version = -1", () => {
  const p = RollbackResponseSchema.safeParse({
    project_document_id: OK_UUID,
    new_lock_version: -1,
    new_version_number: 1,
  });
  isTrue(!p.success, "must be nonneg");
});
Deno.test("response-schema: extra key rejected (strict)", () => {
  const p = RollbackResponseSchema.safeParse({
    project_document_id: OK_UUID,
    new_lock_version: 1,
    new_version_number: 1,
    extra: 1,
  });
  isTrue(!p.success, "strict must reject unexpected fields");
});

// ---- M1: PostgreSQL integer upper bounds on response -------------------
Deno.test("response-schema: new_lock_version = PG_INT_MAX accepted", () => {
  const p = RollbackResponseSchema.safeParse({
    project_document_id: OK_UUID,
    new_lock_version: PG_INT_MAX,
    new_version_number: 1,
  });
  isTrue(p.success, "PG_INT_MAX must be within range");
});
Deno.test("response-schema: new_version_number = PG_INT_MAX accepted", () => {
  const p = RollbackResponseSchema.safeParse({
    project_document_id: OK_UUID,
    new_lock_version: 0,
    new_version_number: PG_INT_MAX,
  });
  isTrue(p.success, "PG_INT_MAX must be within range");
});
Deno.test("response-schema: new_lock_version = PG_INT_MAX + 1 rejected", () => {
  const p = RollbackResponseSchema.safeParse({
    project_document_id: OK_UUID,
    new_lock_version: PG_INT_MAX + 1,
    new_version_number: 1,
  });
  isTrue(!p.success, "overflow must be rejected");
});
Deno.test("response-schema: new_version_number = PG_INT_MAX + 1 rejected", () => {
  const p = RollbackResponseSchema.safeParse({
    project_document_id: OK_UUID,
    new_lock_version: 0,
    new_version_number: PG_INT_MAX + 1,
  });
  isTrue(!p.success, "overflow must be rejected");
});

// ============================================================
// 3) mapRpcError: SQLSTATE + machinecode combined allowlist
// ============================================================
Deno.test("mapRpcError: lock_version_mismatch + 55P03 → 409", () => {
  const m = mapRpcError({ message: "lock_version_mismatch", code: "55P03", details: "current=42" });
  eq(m, { status: 409, body: { error: "lock_version_mismatch" } });
});
Deno.test("mapRpcError: insufficient_role + 42501 → 403", () => {
  const m = mapRpcError({ message: "insufficient_role", code: "42501" });
  eq(m, { status: 403, body: { error: "insufficient_role" } });
});
Deno.test("mapRpcError: membership_not_active + 42501 → 403", () => {
  const m = mapRpcError({ message: "membership_not_active", code: "42501" });
  eq(m, { status: 403, body: { error: "membership_not_active" } });
});
Deno.test("mapRpcError: not_found + 42704 → 404", () => {
  const m = mapRpcError({ message: "not_found", code: "42704" });
  eq(m, { status: 404, body: { error: "not_found" } });
});
Deno.test("mapRpcError: target_version_not_found + 42704 → 404", () => {
  const m = mapRpcError({ message: "target_version_not_found", code: "42704" });
  eq(m, { status: 404, body: { error: "target_version_not_found" } });
});
Deno.test("mapRpcError: organization_not_active + 22023 → 409", () => {
  const m = mapRpcError({ message: "organization_not_active", code: "22023" });
  eq(m, { status: 409, body: { error: "organization_not_active" } });
});
Deno.test("mapRpcError: project_not_active + 22023 → 409", () => {
  const m = mapRpcError({ message: "project_not_active", code: "22023" });
  eq(m, { status: 409, body: { error: "project_not_active" } });
});
Deno.test("mapRpcError: target_schema_version_incompatible + 22023 → 409", () => {
  const m = mapRpcError({ message: "target_schema_version_incompatible", code: "22023" });
  eq(m, { status: 409, body: { error: "target_schema_version_incompatible" } });
});
Deno.test("mapRpcError: known machinecode with wrong SQLSTATE → 500", () => {
  const m = mapRpcError({ message: "lock_version_mismatch", code: "22023" });
  eq(m, { status: 500, body: { error: "internal_error" } });
});
Deno.test("mapRpcError: known SQLSTATE with wrong machinecode → 500", () => {
  const m = mapRpcError({ message: "pg_ferrari_race", code: "55P03" });
  eq(m, { status: 500, body: { error: "internal_error" } });
});
Deno.test("mapRpcError: unknown machinecode → 500", () => {
  const m = mapRpcError({ message: "some_new_thing", code: "22023" });
  eq(m, { status: 500, body: { error: "internal_error" } });
});
Deno.test("mapRpcError: internal invariant missing_actor_user_id → 500 (never exposed)", () => {
  const m = mapRpcError({ message: "missing_actor_user_id", code: "28000" });
  eq(m, { status: 500, body: { error: "internal_error" } });
});
Deno.test("mapRpcError: internal invariant missing_expected_lock_version → 500 (never exposed)", () => {
  const m = mapRpcError({ message: "missing_expected_lock_version", code: "22023" });
  eq(m, { status: 500, body: { error: "internal_error" } });
});
Deno.test("mapRpcError: null → 500", () => {
  eq(mapRpcError(null), { status: 500, body: { error: "internal_error" } });
});
Deno.test("mapRpcError: undefined → 500", () => {
  eq(mapRpcError(undefined), { status: 500, body: { error: "internal_error" } });
});
Deno.test("mapRpcError: empty object → 500", () => {
  eq(mapRpcError({}), { status: 500, body: { error: "internal_error" } });
});
Deno.test("mapRpcError: message only, missing code → 500", () => {
  eq(
    mapRpcError({ message: "lock_version_mismatch" }),
    { status: 500, body: { error: "internal_error" } },
  );
});
Deno.test("mapRpcError: code only, missing message → 500", () => {
  eq(mapRpcError({ code: "55P03" }), { status: 500, body: { error: "internal_error" } });
});
Deno.test("mapRpcError: non-string message → 500", () => {
  eq(
    mapRpcError({ message: 42, code: "55P03" }),
    { status: 500, body: { error: "internal_error" } },
  );
});
Deno.test("mapRpcError: string primitive → 500", () => {
  eq(mapRpcError("oops"), { status: 500, body: { error: "internal_error" } });
});

// ============================================================
// 4) Handler — OPTIONS
// ============================================================
Deno.test("handler: OPTIONS → 204 with permissive CORS, no deps invoked", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(new Request("http://local/", { method: "OPTIONS" }));
  eq(res.status, 204);
  eq(res.headers.get("access-control-allow-origin"), "*");
  eq(res.headers.get("access-control-allow-methods"), CORS_HEADERS["Access-Control-Allow-Methods"]);
  eq(res.headers.get("access-control-allow-headers"), CORS_HEADERS["Access-Control-Allow-Headers"]);
  eq(res.headers.get("access-control-allow-credentials"), null);
  eq(await res.text(), "");
  eq(spy.makeUserClientCalls, 0);
  eq(spy.makeAdminCalls, 0);
  eq(spy.getUserCalls.length, 0);
  eq(spy.rpcCalls.length, 0);
});

Deno.test("handler: GET → 405, no deps invoked", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(new Request("http://local/", { method: "GET" }));
  eq(res.status, 405);
  eq(await bodyOf(res), { error: "method_not_allowed" });
  eq(spy.makeUserClientCalls, 0);
  eq(spy.makeAdminCalls, 0);
});

// ============================================================
// 5) Handler — body-size guard (M2)
// ============================================================
Deno.test("body-size: Content-Length exactly 4096 passes gate", async () => {
  const body = buildExactSizeJson(MAX_REQUEST_BODY_BYTES);
  eq(new TextEncoder().encode(body).byteLength, MAX_REQUEST_BODY_BYTES);
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(new Request("http://local/", {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer x" },
    body,
  }));
  // Size gate passed. JSON parse succeeded. Zod .strict() rejects the pad
  // key with 400 invalid_request, proving downstream code ran.
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_request" });
});

Deno.test("body-size: Content-Length 4097 → 413, no deps invoked", async () => {
  const body = new Uint8Array(MAX_REQUEST_BODY_BYTES + 1);
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(new Request("http://local/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer x",
      "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
    },
    body,
  }));
  eq(res.status, 413);
  eq(await bodyOf(res), { error: "payload_too_large" });
  eq(spy.makeUserClientCalls, 0);
  eq(spy.getUserCalls.length, 0);
  eq(spy.makeAdminCalls, 0);
  eq(spy.rpcCalls.length, 0);
});

Deno.test("body-size: stream body without Content-Length, 4097 bytes → 413", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const bytes = new Uint8Array(MAX_REQUEST_BODY_BYTES + 1).fill(0x41);
  const req = streamReq(bytes, { contentLength: null });
  // Sanity: no Content-Length was set.
  eq(req.headers.get("content-length"), null);
  const res = await h(req);
  eq(res.status, 413);
  eq(await bodyOf(res), { error: "payload_too_large" });
  eq(spy.makeUserClientCalls, 0);
  eq(spy.getUserCalls.length, 0);
  eq(spy.makeAdminCalls, 0);
  eq(spy.rpcCalls.length, 0);
});

Deno.test("body-size: multibyte UTF-8 counted by bytes, not chars → 413", async () => {
  // "é" = 2 bytes UTF-8 → 3000 chars = 6000 bytes > MAX (4096).
  const text = "é".repeat(3000);
  const bytes = new TextEncoder().encode(text);
  eq(bytes.byteLength, 6000);
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  // Use stream to avoid Deno auto-setting a Content-Length that would trip
  // the Content-Length branch instead of the streaming branch.
  const req = streamReq(bytes, { contentLength: null });
  const res = await h(req);
  eq(res.status, 413);
  eq(await bodyOf(res), { error: "payload_too_large" });
  eq(spy.makeUserClientCalls, 0);
});

Deno.test("body-size: malformed Content-Length ('abc') → 400 invalid_request", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const req = streamReq(new TextEncoder().encode("{}"), { contentLength: "abc" });
  const res = await h(req);
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_request" });
  eq(spy.makeUserClientCalls, 0);
});

Deno.test("body-size: malformed Content-Length ('-1') → 400 invalid_request", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const req = streamReq(new TextEncoder().encode("{}"), { contentLength: "-1" });
  const res = await h(req);
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_request" });
  eq(spy.makeUserClientCalls, 0);
});

Deno.test("body-size: malformed Content-Length ('1.5') → 400 invalid_request", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const req = streamReq(new TextEncoder().encode("{}"), { contentLength: "1.5" });
  const res = await h(req);
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_request" });
  eq(spy.makeUserClientCalls, 0);
});

Deno.test("body-size: malformed Content-Length ('10, 20') → 400 invalid_request", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const req = streamReq(new TextEncoder().encode("{}"), { contentLength: "10, 20" });
  const res = await h(req);
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_request" });
  eq(spy.makeUserClientCalls, 0);
});

Deno.test("body-size: 413 response has exactly one public error key", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const body = new Uint8Array(MAX_REQUEST_BODY_BYTES + 1);
  const res = await h(new Request("http://local/", {
    method: "POST",
    headers: {
      "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
      "content-type": "application/json",
      "authorization": "Bearer x",
    },
    body,
  }));
  eq(res.status, 413);
  const bodyJson = await bodyOf(res) as Record<string, unknown>;
  eq(Object.keys(bodyJson), ["error"]);
  eq(bodyJson.error, "payload_too_large");
});

// ---- M-1: stream errors during body read are fail-closed --------------
Deno.test("body-size: stream errors mid-read (controller.error) → 500 internal_error, no deps, no leak", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const INTERNAL_MSG = "stream failed";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(64).fill(0x41));
      controller.error(new Error(INTERNAL_MSG));
    },
  });
  const req = new Request("http://local/", {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "authorization": "Bearer valid.jwt.token",
    }),
    body: stream,
    // deno-lint-ignore no-explicit-any
    ...({ duplex: "half" } as any),
  });
  const res = await h(req);
  eq(res.status, 500);
  isTrue(
    (res.headers.get("content-type") ?? "").includes("application/json"),
    "content-type must include application/json",
  );
  eq(res.headers.get("access-control-allow-origin"), "*");
  eq(res.headers.get("access-control-allow-credentials"), null);
  const bodyText = await res.text();
  eq(JSON.parse(bodyText), { error: "internal_error" });
  // Leak check: the underlying error message must NOT appear anywhere.
  isTrue(!bodyText.includes(INTERNAL_MSG), "internal error message must not leak into body");
  // Zero downstream work.
  eq(spy.makeUserClientCalls, 0);
  eq(spy.getUserCalls.length, 0);
  eq(spy.makeAdminCalls, 0);
  eq(spy.rpcCalls.length, 0);
});

Deno.test("body-size: reader.read() rejects (pull rejection) → 500 internal_error, no deps", async () => {
  // Second variant: a stream whose pull() returns a rejected promise, causing
  // reader.read() to reject on the first call. Confirms the try/catch also
  // covers rejections that surface via read() directly.
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const INTERNAL_MSG = "pull rejected";
  const stream = new ReadableStream<Uint8Array>({
    pull(_controller) {
      return Promise.reject(new Error(INTERNAL_MSG));
    },
  });
  const req = new Request("http://local/", {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "authorization": "Bearer valid.jwt.token",
    }),
    body: stream,
    // deno-lint-ignore no-explicit-any
    ...({ duplex: "half" } as any),
  });
  const res = await h(req);
  eq(res.status, 500);
  const bodyText = await res.text();
  eq(JSON.parse(bodyText), { error: "internal_error" });
  isTrue(!bodyText.includes(INTERNAL_MSG), "internal error message must not leak");
  eq(spy.makeUserClientCalls, 0);
  eq(spy.getUserCalls.length, 0);
  eq(spy.makeAdminCalls, 0);
  eq(spy.rpcCalls.length, 0);
});

// ============================================================
// 6) Handler — auth ordering
// ============================================================
Deno.test("handler: POST without Authorization → 401, no user/admin/rpc", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(postReq(OK_BODY, { auth: null }));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "missing_authorization" });
  eq(spy.makeUserClientCalls, 0);
  eq(spy.makeAdminCalls, 0);
  eq(spy.rpcCalls.length, 0);
});

Deno.test("handler: POST Authorization empty after Bearer → 401", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(postReq(OK_BODY, { auth: "Bearer   " }));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "missing_authorization" });
});

// ---- L3: additional Authorization-parser edge cases ------------------
Deno.test("auth-parser: 'BearerXYZ' (no space) → 401 missing_authorization", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(postReq(OK_BODY, { auth: "BearerXYZ" }));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "missing_authorization" });
  eq(spy.makeUserClientCalls, 0);
});

Deno.test("auth-parser: 'Bearer XX YY' (two tokens) → 401 missing_authorization", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(postReq(OK_BODY, { auth: "Bearer XX YY" }));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "missing_authorization" });
  eq(spy.makeUserClientCalls, 0);
});

Deno.test("auth-parser: 'bearer valid-token' (lowercase scheme) → passes, exact token to getUser", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () => Promise.resolve({
      data: [{ project_document_id: OK_UUID, new_lock_version: 1, new_version_number: 1 }],
      error: null,
    }),
  }));
  const res = await h(postReq(OK_BODY, { auth: "bearer valid-token" }));
  eq(res.status, 200);
  eq(spy.getUserCalls[0], "valid-token");
});

Deno.test("auth-parser: 'Basic sometoken' (wrong scheme) → 401 missing_authorization", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(postReq(OK_BODY, { auth: "Basic sometoken" }));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "missing_authorization" });
  eq(spy.makeUserClientCalls, 0);
});

// ============================================================
// 7) Handler — body validation
// ============================================================
Deno.test("handler: invalid JSON → 400, no user/admin/rpc", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(postReq("{not-json", {}));
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_json" });
  eq(spy.makeUserClientCalls, 0);
  eq(spy.makeAdminCalls, 0);
});

Deno.test("handler: invalid body → 400, no user/admin/rpc", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(postReq({ foo: "bar" }));
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_request" });
  eq(spy.makeUserClientCalls, 0);
  eq(spy.makeAdminCalls, 0);
});

Deno.test("handler: body with p_actor_user_id rejected by strict → 400, no user/admin/rpc", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(postReq({ ...OK_BODY, p_actor_user_id: OTHER_UUID }));
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_request" });
  eq(spy.makeUserClientCalls, 0);
  eq(spy.makeAdminCalls, 0);
});

// ============================================================
// 8) Handler — user validation
// ============================================================
Deno.test("handler: getUser returns error → 401, admin/rpc NOT called", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () =>
      Promise.resolve({
        data: { user: null },
        error: { name: "AuthError", message: "invalid" },
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "invalid_user_token" });
  eq(spy.makeUserClientCalls, 1);
  eq(spy.makeAdminCalls, 0);
  eq(spy.rpcCalls.length, 0);
});

Deno.test("handler: getUser returns user=null → 401, admin/rpc NOT called", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: null }, error: null }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "invalid_user_token" });
  eq(spy.makeAdminCalls, 0);
});

Deno.test("handler: getUser throws → 500, admin/rpc NOT called", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserThrows: () => {
      throw new Error("network");
    },
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
  eq(spy.makeAdminCalls, 0);
});

Deno.test("handler: user.aud='anon' → 401", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () =>
      Promise.resolve({
        data: { user: mkUser({ aud: "anon" }) },
        error: null,
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "invalid_user_token" });
  eq(spy.makeAdminCalls, 0);
});

Deno.test("handler: user.role='service_role' → 401", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () =>
      Promise.resolve({
        data: { user: mkUser({ role: "service_role" }) },
        error: null,
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "invalid_user_token" });
  eq(spy.makeAdminCalls, 0);
});

Deno.test("handler: user.id empty string → 401", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () =>
      Promise.resolve({
        data: { user: mkUser({ id: "" }) },
        error: null,
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 401);
  eq(spy.makeAdminCalls, 0);
});

// ============================================================
// 9) Handler — happy path + actor & JWT invariants
// ============================================================
Deno.test("handler: success — RPC called with p_actor_user_id === user.id", async () => {
  const spy = newSpy();
  const okUser = mkUser({ id: "cccccccc-1111-2222-3333-444444444444" });
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: okUser }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: [{
          project_document_id: OK_UUID,
          new_lock_version: 3,
          new_version_number: 7,
        }],
        error: null,
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 200);
  eq(await bodyOf(res), {
    project_document_id: OK_UUID,
    new_lock_version: 3,
    new_version_number: 7,
  });
  eq(spy.rpcCalls.length, 1);
  eq(spy.rpcCalls[0].name, "rollback_to_version");
  eq(spy.rpcCalls[0].params.p_actor_user_id, okUser.id);
  eq(spy.rpcCalls[0].params.p_project_document_id, OK_BODY.project_document_id);
  eq(spy.rpcCalls[0].params.p_target_version_number, OK_BODY.target_version_number);
  eq(spy.rpcCalls[0].params.p_expected_lock_version, OK_BODY.expected_lock_version);
});

Deno.test("handler: body-supplied p_actor_user_id CANNOT override actor (strict rejects earlier)", async () => {
  const spy = newSpy();
  const okUser = mkUser({ id: "cccccccc-1111-2222-3333-444444444444" });
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: okUser }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: [{ project_document_id: OK_UUID, new_lock_version: 3, new_version_number: 7 }],
        error: null,
      }),
  }));
  const res = await h(postReq({ ...OK_BODY, p_actor_user_id: OTHER_UUID }));
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_request" });
  eq(spy.rpcCalls.length, 0);
});

// ---- M3 + L1: JWT-doorgifte-invariant ---------------------------------
Deno.test("jwt: passed only to getUser; never to makeUserClient/admin/RPC-params", async () => {
  const spy = newSpy();
  const TOKEN = "HANDCRAFTED_TOKEN_XYZ";
  const okUser = mkUser({ id: "cccccccc-1111-2222-3333-444444444444" });
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: okUser }, error: null }),
    rpcResult: () => Promise.resolve({
      data: [{ project_document_id: OK_UUID, new_lock_version: 1, new_version_number: 1 }],
      error: null,
    }),
  }));
  const res = await h(postReq(OK_BODY, { auth: `Bearer ${TOKEN}` }));
  eq(res.status, 200);
  // makeUserClient signature has no JWT parameter; we can only count invocations.
  eq(spy.makeUserClientCalls, 1);
  // getUser receives EXACTLY the extracted token — no Bearer prefix, no trim
  // artefacts. Extra defence against future refactors that could accidentally
  // pass a different token.
  eq(spy.getUserCalls.length, 1);
  eq(spy.getUserCalls[0], TOKEN);
  isTrue(!spy.getUserCalls[0].toLowerCase().includes("bearer"), "getUser must not receive Bearer prefix");
  // Admin was constructed and rpc was called.
  eq(spy.makeAdminCalls, 1);
  eq(spy.rpcCalls.length, 1);
  // Token must not appear anywhere in the RPC params.
  const paramsStr = JSON.stringify(spy.rpcCalls[0].params);
  isTrue(!paramsStr.includes(TOKEN), "token must not appear in RPC params");
  // The four RPC param keys are exactly what the RPC contract expects.
  const paramKeys = Object.keys(spy.rpcCalls[0].params).sort();
  eq(paramKeys, [
    "p_actor_user_id",
    "p_expected_lock_version",
    "p_project_document_id",
    "p_target_version_number",
  ]);
});

// ============================================================
// 10) Handler — RPC error mapping (integration)
// ============================================================
Deno.test("handler: RPC lock_version_mismatch (55P03) → 409, no leak of details", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: null,
        error: {
          message: "lock_version_mismatch",
          code: "55P03",
          details: "current=42",
          hint: "leaked hint",
        },
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 409);
  const body = await bodyOf(res) as Record<string, unknown>;
  eq(body, { error: "lock_version_mismatch" });
  isTrue(!("details" in body), "details must not leak");
  isTrue(!("hint" in body), "hint must not leak");
  isTrue(!("code" in body), "code must not leak");
});

Deno.test("handler: RPC insufficient_role (42501) → 403", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: null,
        error: { message: "insufficient_role", code: "42501" },
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 403);
  eq(await bodyOf(res), { error: "insufficient_role" });
});

Deno.test("handler: RPC target_schema_version_incompatible (22023) → 409", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: null,
        error: {
          message: "target_schema_version_incompatible",
          code: "22023",
          details: "current=v1; target=v2",
        },
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 409);
  eq(await bodyOf(res), { error: "target_schema_version_incompatible" });
});

Deno.test("handler: RPC known machinecode with wrong SQLSTATE → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: null,
        error: { message: "lock_version_mismatch", code: "22023" },
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

Deno.test("handler: RPC known SQLSTATE with wrong machinecode → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: null,
        error: { message: "pg_ferrari_race", code: "55P03" },
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

Deno.test("handler: RPC internal invariant missing_actor_user_id → 500 (never exposed)", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: null,
        error: { message: "missing_actor_user_id", code: "28000" },
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

Deno.test("handler: RPC throws → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcThrows: () => {
      throw new Error("boom");
    },
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

// ============================================================
// 11) Handler — RPC success shape validation
// ============================================================
Deno.test("handler: RPC success data=null → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () => Promise.resolve({ data: null, error: null }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});
Deno.test("handler: RPC success data=object (not array) → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: { project_document_id: OK_UUID, new_lock_version: 1, new_version_number: 1 },
        error: null,
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});
Deno.test("handler: RPC success data=[] → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () => Promise.resolve({ data: [], error: null }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
});
Deno.test("handler: RPC success data with 2 rows → 500", async () => {
  const spy = newSpy();
  const row = { project_document_id: OK_UUID, new_lock_version: 1, new_version_number: 1 };
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () => Promise.resolve({ data: [row, row], error: null }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
});
Deno.test("handler: RPC success row missing field → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: [{ project_document_id: OK_UUID, new_lock_version: 1 }],
        error: null,
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
});
Deno.test("handler: RPC success row with extra field → 500 (strict)", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: [{
          project_document_id: OK_UUID,
          new_lock_version: 1,
          new_version_number: 1,
          extra: "leak",
        }],
        error: null,
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
});
Deno.test("handler: RPC success new_version_number = 0 → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: [{ project_document_id: OK_UUID, new_lock_version: 1, new_version_number: 0 }],
        error: null,
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
});
Deno.test("handler: RPC success new_lock_version = -1 → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: [{ project_document_id: OK_UUID, new_lock_version: -1, new_version_number: 1 }],
        error: null,
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
});

// ---- M1: response-side integer overflow → 500 -------------------------
Deno.test("handler: RPC success new_lock_version = PG_INT_MAX + 1 → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: [{ project_document_id: OK_UUID, new_lock_version: PG_INT_MAX + 1, new_version_number: 1 }],
        error: null,
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});
Deno.test("handler: RPC success new_version_number = PG_INT_MAX + 1 → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: [{ project_document_id: OK_UUID, new_lock_version: 0, new_version_number: PG_INT_MAX + 1 }],
        error: null,
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

// ============================================================
// 12) Handler — dependency-construction errors
// ============================================================
Deno.test("handler: makeUserClient throws → 500 before getUser/admin/rpc", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy, makeUserClientThrows: true }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
  eq(spy.getUserCalls.length, 0);
  eq(spy.makeAdminCalls, 0);
  eq(spy.rpcCalls.length, 0);
});

Deno.test("handler: makeAdmin throws (after auth OK) → 500, rpc NOT called", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    makeAdminThrows: true,
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
  eq(spy.rpcCalls.length, 0);
});

// ============================================================
// 13) Response-shape invariants across all error/success responses
// ============================================================
Deno.test("handler: every error response body has exactly one key: 'error'", async () => {
  const cases: Array<Request> = [
    new Request("http://local/", { method: "GET" }),
    postReq(OK_BODY, { auth: null }),
    postReq("{bad", {}),
    postReq({ nope: 1 }),
  ];
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  for (const req of cases) {
    const res = await h(req);
    const body = await bodyOf(res) as Record<string, unknown>;
    eq(Object.keys(body), ["error"], `expected exactly ['error']; got ${JSON.stringify(Object.keys(body))}`);
  }
});

Deno.test("handler: success response body has exactly the three expected keys", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () =>
      Promise.resolve({
        data: [{ project_document_id: OK_UUID, new_lock_version: 5, new_version_number: 9 }],
        error: null,
      }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 200);
  const body = await bodyOf(res) as Record<string, unknown>;
  eq(Object.keys(body).sort(), ["new_lock_version", "new_version_number", "project_document_id"]);
});

// ---- L4: response-header contract for every representative status ----
Deno.test("headers: every response has content-type + ACAO=*, never ACAC", async () => {
  const okRow = { project_document_id: OK_UUID, new_lock_version: 1, new_version_number: 1 };
  const build200 = () => makeHandler(makeDeps({
    spy: newSpy(),
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () => Promise.resolve({ data: [okRow], error: null }),
  }));
  const build500Throw = () => makeHandler(makeDeps({
    spy: newSpy(),
    getUserThrows: () => { throw new Error("net"); },
  }));
  const build409 = () => makeHandler(makeDeps({
    spy: newSpy(),
    getUserResult: () => Promise.resolve({ data: { user: mkUser() }, error: null }),
    rpcResult: () => Promise.resolve({
      data: null,
      error: { message: "lock_version_mismatch", code: "55P03" },
    }),
  }));

  const cases: Array<{ name: string; run: () => Promise<Response>; expectStatus: number }> = [
    { name: "200", run: () => build200()(postReq(OK_BODY)), expectStatus: 200 },
    { name: "400 invalid_request", run: () => makeHandler(makeDeps({ spy: newSpy() }))(postReq({ nope: 1 })), expectStatus: 400 },
    { name: "401 missing_authorization", run: () => makeHandler(makeDeps({ spy: newSpy() }))(postReq(OK_BODY, { auth: null })), expectStatus: 401 },
    { name: "409 lock_version_mismatch", run: () => build409()(postReq(OK_BODY)), expectStatus: 409 },
    {
      name: "413 payload_too_large",
      run: () => makeHandler(makeDeps({ spy: newSpy() }))(new Request("http://local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer x",
          "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
        },
        body: new Uint8Array(MAX_REQUEST_BODY_BYTES + 1),
      })),
      expectStatus: 413,
    },
    { name: "500 internal_error", run: () => build500Throw()(postReq(OK_BODY)), expectStatus: 500 },
  ];

  for (const c of cases) {
    const res = await c.run();
    eq(res.status, c.expectStatus, `${c.name}: unexpected status`);
    isTrue(
      (res.headers.get("content-type") ?? "").includes("application/json"),
      `${c.name}: content-type must include application/json`,
    );
    eq(res.headers.get("access-control-allow-origin"), "*", `${c.name}: ACAO`);
    eq(res.headers.get("access-control-allow-credentials"), null, `${c.name}: ACAC must not be present`);
    const body = await bodyOf(res) as Record<string, unknown>;
    if (c.expectStatus === 200) {
      eq(Object.keys(body).sort(), ["new_lock_version", "new_version_number", "project_document_id"]);
    } else {
      eq(Object.keys(body), ["error"]);
    }
  }
});

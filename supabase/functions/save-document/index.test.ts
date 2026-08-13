import type { SupabaseClient, User } from "@supabase/supabase-js";
import { makeHandler } from "./handler.ts";
import {
  CORS_HEADERS,
  MAX_REQUEST_BODY_BYTES,
  mapRpcError,
  PG_INT_MAX,
  SaveRequestSchema,
  SaveResponseSchema,
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
const OK_PROJECT_UUID = "22222222-2222-2222-2222-222222222222";
const OK_USER_UUID = "44444444-4444-4444-4444-444444444444";

const OK_DOC = {
  version: "0.1.0",
  project: { documentType: "website", title: "Current" },
  pages: [{ id: "p1", root: { id: "r", type: "layout-column", props: {} } }],
};
const OK_BODY = {
  project_id: OK_PROJECT_UUID,
  doc: OK_DOC,
  schema_version: "0.1.0",
  expected_lock_version: 1,
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
    id: OK_USER_UUID,
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

function streamReq(
  bytes: Uint8Array,
  opts: { auth?: string; contentLength?: string | null } = {},
): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const chunkSize = 4096;
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
  return new Request("http://local/", {
    method: "POST",
    headers,
    body: stream,
    // deno-lint-ignore no-explicit-any
    ...({ duplex: "half" } as any),
  });
}

// Build a JSON body of exactly `targetBytes` bytes, containing the canonical
// four fields plus a padding key. Valid JSON, but zod.strict() rejects the
// pad key — useful to prove size-gate passed AND downstream code ran.
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
// 1) Zod: SaveRequestSchema
// ============================================================
Deno.test("request-schema: valid input", () => {
  isTrue(SaveRequestSchema.safeParse(OK_BODY).success, "canonical");
});
Deno.test("request-schema: non-uuid project_id rejected", () => {
  isTrue(
    !SaveRequestSchema.safeParse({ ...OK_BODY, project_id: "nope" }).success,
    "uuid",
  );
});
Deno.test("request-schema: expected_lock_version = 0 rejected", () => {
  isTrue(
    !SaveRequestSchema.safeParse({ ...OK_BODY, expected_lock_version: 0 })
      .success,
    "must be ≥ 1",
  );
});
Deno.test("request-schema: expected_lock_version = -1 rejected", () => {
  isTrue(
    !SaveRequestSchema.safeParse({ ...OK_BODY, expected_lock_version: -1 })
      .success,
    "positive-only",
  );
});
Deno.test("request-schema: expected_lock_version = PG_INT_MAX accepted", () => {
  isTrue(
    SaveRequestSchema.safeParse({ ...OK_BODY, expected_lock_version: PG_INT_MAX })
      .success,
    "boundary",
  );
});
Deno.test("request-schema: expected_lock_version = PG_INT_MAX + 1 rejected", () => {
  isTrue(
    !SaveRequestSchema.safeParse({
      ...OK_BODY,
      expected_lock_version: PG_INT_MAX + 1,
    }).success,
    "overflow",
  );
});
Deno.test("request-schema: expected_lock_version = 1.5 rejected (not int)", () => {
  isTrue(
    !SaveRequestSchema.safeParse({ ...OK_BODY, expected_lock_version: 1.5 })
      .success,
    "integer only",
  );
});
Deno.test("request-schema: empty schema_version rejected", () => {
  isTrue(
    !SaveRequestSchema.safeParse({ ...OK_BODY, schema_version: "" }).success,
    "min(1)",
  );
});
Deno.test("request-schema: schema_version > 64 chars rejected", () => {
  isTrue(
    !SaveRequestSchema.safeParse({
      ...OK_BODY,
      schema_version: "x".repeat(65),
    }).success,
    "max(64)",
  );
});
Deno.test("request-schema: doc missing version rejected", () => {
  const bad = { ...OK_DOC } as Record<string, unknown>;
  delete bad.version;
  isTrue(
    !SaveRequestSchema.safeParse({ ...OK_BODY, doc: bad }).success,
    "chk_doc_shape parity",
  );
});
Deno.test("request-schema: doc missing pages rejected", () => {
  const bad = { ...OK_DOC } as Record<string, unknown>;
  delete bad.pages;
  isTrue(
    !SaveRequestSchema.safeParse({ ...OK_BODY, doc: bad }).success,
    "chk_doc_shape parity",
  );
});
Deno.test("request-schema: doc with empty pages rejected", () => {
  const bad = { ...OK_DOC, pages: [] };
  isTrue(
    !SaveRequestSchema.safeParse({ ...OK_BODY, doc: bad }).success,
    "pages.length >= 1",
  );
});
Deno.test("request-schema: doc with invalid documentType rejected", () => {
  const bad = {
    ...OK_DOC,
    project: { ...OK_DOC.project, documentType: "banner" },
  };
  isTrue(
    !SaveRequestSchema.safeParse({ ...OK_BODY, doc: bad }).success,
    "enum",
  );
});
Deno.test("request-schema: doc extra fields ARE allowed (passthrough)", () => {
  const doc = { ...OK_DOC, brandTokens: { "brand.primary": "#000" } };
  isTrue(
    SaveRequestSchema.safeParse({ ...OK_BODY, doc }).success,
    "passthrough",
  );
});
Deno.test("request-schema: unknown top-level key rejected (strict)", () => {
  isTrue(
    !SaveRequestSchema.safeParse({ ...OK_BODY, p_actor_user_id: OK_USER_UUID })
      .success,
    "strict must reject body-injection of actor id",
  );
});

// ============================================================
// 2) Zod: SaveResponseSchema
// ============================================================
Deno.test("response-schema: valid row", () => {
  isTrue(
    SaveResponseSchema.safeParse({ new_lock_version: 2 }).success,
    "canonical",
  );
});
Deno.test("response-schema: new_lock_version = 0 rejected", () => {
  isTrue(
    !SaveResponseSchema.safeParse({ new_lock_version: 0 }).success,
    "positive-only",
  );
});
Deno.test("response-schema: extra key rejected (strict)", () => {
  isTrue(
    !SaveResponseSchema.safeParse({ new_lock_version: 2, extra: 1 }).success,
    "strict",
  );
});

// ============================================================
// 3) mapRpcError — SQLSTATE + machinecode combined allowlist
// ============================================================
Deno.test("mapRpcError: lock_version_mismatch + 55P03 → 409", () => {
  eq(mapRpcError({ message: "lock_version_mismatch", code: "55P03" }), {
    status: 409,
    body: { error: "lock_version_mismatch" },
  });
});
Deno.test("mapRpcError: insufficient_role + 42501 → 403", () => {
  eq(mapRpcError({ message: "insufficient_role", code: "42501" }), {
    status: 403,
    body: { error: "insufficient_role" },
  });
});
Deno.test("mapRpcError: membership_not_active + 42501 → 403", () => {
  eq(mapRpcError({ message: "membership_not_active", code: "42501" }), {
    status: 403,
    body: { error: "membership_not_active" },
  });
});
Deno.test("mapRpcError: project_not_found + 42704 → 404", () => {
  eq(mapRpcError({ message: "project_not_found", code: "42704" }), {
    status: 404,
    body: { error: "project_not_found" },
  });
});
Deno.test("mapRpcError: document_not_found + 42704 → 404", () => {
  eq(mapRpcError({ message: "document_not_found", code: "42704" }), {
    status: 404,
    body: { error: "document_not_found" },
  });
});
Deno.test("mapRpcError: organization_not_active + 22023 → 409", () => {
  eq(mapRpcError({ message: "organization_not_active", code: "22023" }), {
    status: 409,
    body: { error: "organization_not_active" },
  });
});
Deno.test("mapRpcError: project_not_active + 22023 → 409", () => {
  eq(mapRpcError({ message: "project_not_active", code: "22023" }), {
    status: 409,
    body: { error: "project_not_active" },
  });
});
Deno.test("mapRpcError: known machinecode with wrong SQLSTATE → 500", () => {
  eq(mapRpcError({ message: "lock_version_mismatch", code: "22023" }), {
    status: 500,
    body: { error: "internal_error" },
  });
});
Deno.test("mapRpcError: unknown machinecode → 500", () => {
  eq(mapRpcError({ message: "some_new_thing", code: "22023" }), {
    status: 500,
    body: { error: "internal_error" },
  });
});
Deno.test("mapRpcError: internal invariant missing_actor_user_id → 500", () => {
  eq(mapRpcError({ message: "missing_actor_user_id", code: "28000" }), {
    status: 500,
    body: { error: "internal_error" },
  });
});
Deno.test("mapRpcError: check_violation (23514) → 500 (never exposed)", () => {
  eq(
    mapRpcError({ message: "new row for relation violates check", code: "23514" }),
    { status: 500, body: { error: "internal_error" } },
  );
});
Deno.test("mapRpcError: null / undefined / empty / primitives → 500", () => {
  eq(mapRpcError(null), { status: 500, body: { error: "internal_error" } });
  eq(mapRpcError(undefined), { status: 500, body: { error: "internal_error" } });
  eq(mapRpcError({}), { status: 500, body: { error: "internal_error" } });
  eq(mapRpcError("oops"), { status: 500, body: { error: "internal_error" } });
});
Deno.test("mapRpcError: non-string message → 500", () => {
  eq(mapRpcError({ message: 42, code: "55P03" }), {
    status: 500,
    body: { error: "internal_error" },
  });
});

// ============================================================
// 4) Handler — method/OPTIONS
// ============================================================
Deno.test("handler: OPTIONS → 204 with CORS, no deps invoked", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(new Request("http://local/", { method: "OPTIONS" }));
  eq(res.status, 204);
  eq(res.headers.get("access-control-allow-origin"), "*");
  eq(
    res.headers.get("access-control-allow-methods"),
    CORS_HEADERS["Access-Control-Allow-Methods"],
  );
  eq(await res.text(), "");
  eq(spy.makeUserClientCalls, 0);
});

Deno.test("handler: PUT → 405, no deps invoked", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(new Request("http://local/", { method: "PUT" }));
  eq(res.status, 405);
  eq(await bodyOf(res), { error: "method_not_allowed" });
  eq(spy.makeUserClientCalls, 0);
});

// ============================================================
// 5) Handler — body-size guard
// ============================================================
Deno.test("body-size: Content-Length exactly MAX passes gate", async () => {
  const body = buildExactSizeJson(MAX_REQUEST_BODY_BYTES);
  eq(new TextEncoder().encode(body).byteLength, MAX_REQUEST_BODY_BYTES);
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(
    new Request("http://local/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer x",
      },
      body,
    }),
  );
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_request" });
});

Deno.test("body-size: Content-Length MAX+1 → 413, no deps invoked", async () => {
  const body = new Uint8Array(MAX_REQUEST_BODY_BYTES + 1);
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(
    new Request("http://local/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer x",
        "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
      },
      body,
    }),
  );
  eq(res.status, 413);
  eq(await bodyOf(res), { error: "payload_too_large" });
  eq(spy.makeUserClientCalls, 0);
});

Deno.test("body-size: stream body without Content-Length, MAX+1 bytes → 413", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const bytes = new Uint8Array(MAX_REQUEST_BODY_BYTES + 1).fill(0x41);
  const req = streamReq(bytes, { contentLength: null });
  eq(req.headers.get("content-length"), null);
  const res = await h(req);
  eq(res.status, 413);
  eq(await bodyOf(res), { error: "payload_too_large" });
  eq(spy.makeUserClientCalls, 0);
});

Deno.test("body-size: multibyte UTF-8 counted by bytes → 413", async () => {
  const charCount = Math.floor(MAX_REQUEST_BODY_BYTES / 2) + 1;
  const text = "é".repeat(charCount);
  const bytes = new TextEncoder().encode(text);
  isTrue(bytes.byteLength > MAX_REQUEST_BODY_BYTES, "fixture must exceed max");
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(streamReq(bytes, { contentLength: null }));
  eq(res.status, 413);
  eq(await bodyOf(res), { error: "payload_too_large" });
});

Deno.test("body-size: malformed Content-Length '-1' → 400", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(
    new Request("http://local/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer x",
        "content-length": "-1",
      },
      body: JSON.stringify(OK_BODY),
    }),
  );
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_request" });
});

// ============================================================
// 6) Handler — auth header
// ============================================================
Deno.test("handler: missing Authorization → 401", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(postReq(OK_BODY, { auth: null }));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "missing_authorization" });
  eq(spy.makeUserClientCalls, 0);
});

Deno.test("handler: non-Bearer Authorization → 401", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(postReq(OK_BODY, { auth: "Basic dXNlcjpwYXNz" }));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "missing_authorization" });
});

// ============================================================
// 7) Handler — invalid JSON / Zod
// ============================================================
Deno.test("handler: invalid JSON → 400 invalid_json", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(postReq("{not valid"));
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_json" });
  eq(spy.makeUserClientCalls, 0);
});

Deno.test("handler: Zod-invalid body → 400 invalid_request", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(postReq({ ...OK_BODY, expected_lock_version: 0 }));
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_request" });
  eq(spy.makeUserClientCalls, 0);
});

Deno.test("handler: strict rejects p_actor_user_id in body → 400", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(postReq({ ...OK_BODY, p_actor_user_id: OK_USER_UUID }));
  eq(res.status, 400);
  eq(await bodyOf(res), { error: "invalid_request" });
  eq(spy.rpcCalls.length, 0);
});

// ============================================================
// 8) Handler — user token validation
// ============================================================
Deno.test("handler: getUser returns error → 401 invalid_user_token", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({
      data: { user: null },
      error: { message: "invalid" },
    }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "invalid_user_token" });
  eq(spy.makeAdminCalls, 0);
});

Deno.test("handler: getUser returns user with wrong aud → 401", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({
      data: { user: mkUser({ aud: "anon" }) },
      error: null,
    }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "invalid_user_token" });
});

Deno.test("handler: getUser returns user with wrong role → 401", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({
      data: { user: mkUser({ role: "service_role" }) },
      error: null,
    }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "invalid_user_token" });
});

Deno.test("handler: getUser returns user with empty id → 401", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({
      data: { user: mkUser({ id: "" }) },
      error: null,
    }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 401);
  eq(await bodyOf(res), { error: "invalid_user_token" });
});

Deno.test("handler: getUser throws → 500 internal_error", async () => {
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
});

Deno.test("handler: makeUserClient throws → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy, makeUserClientThrows: true }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

Deno.test("handler: makeAdmin throws → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    makeAdminThrows: true,
    getUserResult: async () => ({ data: { user: mkUser() }, error: null }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

// ============================================================
// 9) Handler — RPC call shape + happy path + errors
// ============================================================
Deno.test("handler: happy path → 200, actor from JWT, params correct", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({ data: { user: mkUser() }, error: null }),
    rpcResult: async () => ({ data: 2, error: null }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 200);
  eq(await bodyOf(res), { new_lock_version: 2 });
  eq(spy.rpcCalls.length, 1);
  eq(spy.rpcCalls[0].name, "save_document_internal");
  eq(spy.rpcCalls[0].params.p_actor_user_id, OK_USER_UUID);
  eq(spy.rpcCalls[0].params.p_project_id, OK_PROJECT_UUID);
  eq(spy.rpcCalls[0].params.p_schema_version, "0.1.0");
  eq(spy.rpcCalls[0].params.p_expected_lock_version, 1);
});

Deno.test("handler: RPC error lock_version_mismatch → 409", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({ data: { user: mkUser() }, error: null }),
    rpcResult: async () => ({
      data: null,
      error: {
        message: "lock_version_mismatch",
        code: "55P03",
        details: "current=42",
      },
    }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 409);
  eq(await bodyOf(res), { error: "lock_version_mismatch" });
});

Deno.test("handler: RPC error document_not_found → 404", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({ data: { user: mkUser() }, error: null }),
    rpcResult: async () => ({
      data: null,
      error: { message: "document_not_found", code: "42704" },
    }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 404);
  eq(await bodyOf(res), { error: "document_not_found" });
});

Deno.test("handler: RPC error 23514 check_violation → 500 (never leaks)", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({ data: { user: mkUser() }, error: null }),
    rpcResult: async () => ({
      data: null,
      error: {
        message: "new row for relation violates check constraint",
        code: "23514",
      },
    }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

Deno.test("handler: RPC returns non-number → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({ data: { user: mkUser() }, error: null }),
    rpcResult: async () => ({ data: [2], error: null }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

Deno.test("handler: RPC returns null → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({ data: { user: mkUser() }, error: null }),
    rpcResult: async () => ({ data: null, error: null }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

Deno.test("handler: RPC returns 0 → 500 (below lock_version minimum)", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({ data: { user: mkUser() }, error: null }),
    rpcResult: async () => ({ data: 0, error: null }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

Deno.test("handler: RPC returns PG_INT_MAX+1 → 500 (overflow)", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({ data: { user: mkUser() }, error: null }),
    rpcResult: async () => ({ data: PG_INT_MAX + 1, error: null }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

Deno.test("handler: RPC returns 1.5 → 500 (not safe integer)", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({ data: { user: mkUser() }, error: null }),
    rpcResult: async () => ({ data: 1.5, error: null }),
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

Deno.test("handler: RPC throws → 500", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({
    spy,
    getUserResult: async () => ({ data: { user: mkUser() }, error: null }),
    rpcThrows: () => {
      throw new Error("connection reset");
    },
  }));
  const res = await h(postReq(OK_BODY));
  eq(res.status, 500);
  eq(await bodyOf(res), { error: "internal_error" });
});

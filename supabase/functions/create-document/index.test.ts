// Deno-tests voor create-document Edge Function. Mirrort de bestaande
// create-project-document-tests (bootstrap-only), maar voor het pad waar
// een NIEUW document wordt aangemaakt in een BESTAAND project.

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { makeHandler } from "./handler.ts";

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

const PROJECT_UUID = "11111111-1111-1111-1111-111111111111";
const PROJECT_DOC_UUID = "22222222-2222-2222-2222-222222222222";
const USER_UUID = "44444444-4444-4444-4444-444444444444";

const OK_SEED = {
  version: "0.1.0",
  project: { documentType: "website", title: "Nieuw" },
  pages: [{ id: "p1", root: { id: "r", type: "layout-column", props: {} } }],
};
const OK_BODY = {
  project_id: PROJECT_UUID,
  document_type: "website",
  title: "Homepagina",
  seed_doc: OK_SEED,
  schema_version: "0.1.0",
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

// ---- Stubs -----------------------------------------------------------------

interface Spy {
  rpcCalls: Array<{ name: string; params: Record<string, unknown> }>;
}
function newSpy(): Spy { return { rpcCalls: [] }; }

interface StubOpts {
  spy: Spy;
  user?: User | null;
  rpcResult?: { data: unknown; error: unknown };
}

function makeDeps(opts: StubOpts) {
  return {
    makeUserClient(): SupabaseClient {
      return {
        auth: {
          getUser: async () => ({
            data: { user: opts.user === undefined ? OK_USER : opts.user },
            error: null,
          }),
        },
      } as unknown as SupabaseClient;
    },
    makeAdmin(): SupabaseClient {
      return {
        rpc: async (name: string, params: Record<string, unknown>) => {
          opts.spy.rpcCalls.push({ name, params });
          return opts.rpcResult ?? {
            data: [
              { project_document_id: PROJECT_DOC_UUID, lock_version: 1 },
            ],
            error: null,
          };
        },
      } as unknown as SupabaseClient;
    },
  };
}

function makeReq(body: unknown, opts: { auth?: string | null; method?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== null) headers.authorization = opts.auth ?? "Bearer test-jwt";
  return new Request("https://x.local/create-document", {
    method: opts.method ?? "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
async function bodyOf(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>;
}

// ---- Tests -----------------------------------------------------------------

Deno.test("405 on GET", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(new Request("https://x.local/", { method: "GET" }));
  eq(res.status, 405);
});

Deno.test("204 on OPTIONS + CORS", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(new Request("https://x.local/", { method: "OPTIONS" }));
  eq(res.status, 204);
  isTrue(res.headers.get("access-control-allow-origin") === "*", "CORS present");
});

Deno.test("401 on missing authorization", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(makeReq(OK_BODY, { auth: null }));
  eq(res.status, 401);
  eq((await bodyOf(res)).error, "missing_authorization");
});

Deno.test("400 on invalid_json body", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(makeReq("not-json"));
  eq(res.status, 400);
  eq((await bodyOf(res)).error, "invalid_json");
});

Deno.test("400 on Zod-invalid body (missing title)", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const { title: _t, ...rest } = OK_BODY;
  void _t;
  const res = await h(makeReq(rest));
  eq(res.status, 400);
  eq((await bodyOf(res)).error, "invalid_request");
});

Deno.test("400 on invalid document_type", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(makeReq({ ...OK_BODY, document_type: "not-a-type" }));
  eq(res.status, 400);
  eq((await bodyOf(res)).error, "invalid_request");
});

Deno.test("401 when JWT returns no user", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy, user: null }));
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 401);
  eq((await bodyOf(res)).error, "invalid_user_token");
});

Deno.test("happy path — RPC called with correct params, response echoed", async () => {
  const spy = newSpy();
  const h = makeHandler(makeDeps({ spy }));
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 200);
  const body = await bodyOf(res);
  eq(body.project_document_id, PROJECT_DOC_UUID);
  eq(body.lock_version, 1);

  eq(spy.rpcCalls.length, 1);
  eq(spy.rpcCalls[0]!.name, "create_project_document");
  eq(spy.rpcCalls[0]!.params.p_actor_user_id, USER_UUID);
  eq(spy.rpcCalls[0]!.params.p_project_id, PROJECT_UUID);
  eq(spy.rpcCalls[0]!.params.p_document_type, "website");
  eq(spy.rpcCalls[0]!.params.p_title, "Homepagina");
  eq(spy.rpcCalls[0]!.params.p_schema_version, "0.1.0");
});

Deno.test("403 op RPC-error insufficient_role", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps({
      spy,
      rpcResult: {
        data: null,
        error: { message: "insufficient_role", code: "42501" },
      },
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 403);
  eq((await bodyOf(res)).error, "insufficient_role");
});

Deno.test("409 op RPC-error project_not_active", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps({
      spy,
      rpcResult: {
        data: null,
        error: { message: "project_not_active", code: "22023" },
      },
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 409);
  eq((await bodyOf(res)).error, "project_not_active");
});

Deno.test("500 op RPC-error die niet in allowlist zit (defence-in-depth)", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps({
      spy,
      rpcResult: {
        data: null,
        // 23514 chk_doc_shape zou in principe niet moeten voorkomen (Zod
        // vangt malformed seed), maar als het toch gebeurt: generic 500.
        error: { message: "chk_doc_shape", code: "23514" },
      },
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 500);
  eq((await bodyOf(res)).error, "internal_error");
});

Deno.test("500 als RPC-response niet een 1-rij TABLE is", async () => {
  const spy = newSpy();
  const h = makeHandler(
    makeDeps({
      spy,
      rpcResult: { data: [], error: null },
    }),
  );
  const res = await h(makeReq(OK_BODY));
  eq(res.status, 500);
});

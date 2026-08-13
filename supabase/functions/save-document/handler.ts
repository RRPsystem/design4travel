import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  CORS_HEADERS,
  jsonResponse,
  MAX_REQUEST_BODY_BYTES,
  mapRpcError,
  PG_INT_MAX,
  SaveRequestSchema,
} from "./schema.ts";

export interface HandlerDeps {
  makeUserClient: () => SupabaseClient;
  makeAdmin: () => SupabaseClient;
}

type BodyReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" | "malformed_length" };

async function readBoundedBody(
  req: Request,
  maxBytes: number,
): Promise<BodyReadResult> {
  const clHeader = req.headers.get("content-length");
  if (clHeader !== null) {
    // Strict: "0" or a non-zero digit sequence only. Rejects whitespace,
    // leading zeros, signs, decimal points, and comma-joined multi-headers.
    if (!/^(?:0|[1-9][0-9]*)$/.test(clHeader)) {
      return { ok: false, reason: "malformed_length" };
    }
    const cl = Number(clHeader);
    if (!Number.isSafeInteger(cl) || cl < 0) {
      return { ok: false, reason: "malformed_length" };
    }
    if (cl > maxBytes) return { ok: false, reason: "too_large" };
  }

  const body = req.body;
  if (body === null) return { ok: true, bytes: new Uint8Array(0) };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch { /* stream may already be closed */ }
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
  }

  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { ok: true, bytes: buf };
}

export function makeHandler(deps: HandlerDeps) {
  return async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    // Body-size guard runs BEFORE auth-header extraction, deps construction,
    // and any downstream work. A 413 or 400 here never touches the network.
    let bodyRead: BodyReadResult;
    try {
      bodyRead = await readBoundedBody(req, MAX_REQUEST_BODY_BYTES);
    } catch {
      return jsonResponse({ error: "internal_error" }, 500);
    }
    if (!bodyRead.ok) {
      if (bodyRead.reason === "too_large") {
        return jsonResponse({ error: "payload_too_large" }, 413);
      }
      return jsonResponse({ error: "invalid_request" }, 400);
    }

    const authHeader = req.headers.get("authorization") ?? "";
    const bearerMatch = /^Bearer\s+(\S+)\s*$/i.exec(authHeader);
    const jwt = bearerMatch ? bearerMatch[1] : "";
    if (!jwt) return jsonResponse({ error: "missing_authorization" }, 401);

    let raw: unknown;
    try {
      const text = new TextDecoder("utf-8").decode(bodyRead.bytes);
      raw = JSON.parse(text);
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    const parsed = SaveRequestSchema.safeParse(raw);
    if (!parsed.success) return jsonResponse({ error: "invalid_request" }, 400);
    const input = parsed.data;

    let userClient: SupabaseClient;
    try {
      userClient = deps.makeUserClient();
    } catch {
      return jsonResponse({ error: "internal_error" }, 500);
    }

    let user: User | null = null;
    try {
      const res = await userClient.auth.getUser(jwt);
      if (res.error) user = null;
      else user = res.data?.user ?? null;
    } catch {
      return jsonResponse({ error: "internal_error" }, 500);
    }

    if (!user) return jsonResponse({ error: "invalid_user_token" }, 401);
    if (user.aud !== "authenticated") {
      return jsonResponse({ error: "invalid_user_token" }, 401);
    }
    if (user.role !== "authenticated") {
      return jsonResponse({ error: "invalid_user_token" }, 401);
    }
    if (typeof user.id !== "string" || user.id.length === 0) {
      return jsonResponse({ error: "invalid_user_token" }, 401);
    }
    const actorUserId = user.id;

    let admin: SupabaseClient;
    try {
      admin = deps.makeAdmin();
    } catch {
      return jsonResponse({ error: "internal_error" }, 500);
    }

    let rpcResult: { data: unknown; error: unknown };
    try {
      rpcResult = (await admin.rpc("save_document_internal", {
        p_actor_user_id: actorUserId,
        p_project_id: input.project_id,
        p_doc: input.doc,
        p_schema_version: input.schema_version,
        p_expected_lock_version: input.expected_lock_version,
      })) as { data: unknown; error: unknown };
    } catch {
      return jsonResponse({ error: "internal_error" }, 500);
    }

    if (rpcResult.error) {
      const mapped = mapRpcError(rpcResult.error);
      return jsonResponse(mapped.body, mapped.status);
    }

    // save_document_internal returns integer (scalar) — supabase-js gives
    // the value directly, not wrapped in an array.
    if (typeof rpcResult.data !== "number") {
      return jsonResponse({ error: "internal_error" }, 500);
    }
    if (!Number.isSafeInteger(rpcResult.data)) {
      return jsonResponse({ error: "internal_error" }, 500);
    }
    if (rpcResult.data < 1 || rpcResult.data > PG_INT_MAX) {
      return jsonResponse({ error: "internal_error" }, 500);
    }
    return jsonResponse({ new_lock_version: rpcResult.data }, 200);
  };
}

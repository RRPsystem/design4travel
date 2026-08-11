import { z } from "zod";

// PostgreSQL `integer` (int4) upper bound. Values above this overflow the
// column type in the RPC (SQLSTATE 22003). Reject earlier with 400 so the
// client gets an actionable signal instead of a generic 500.
export const PG_INT_MAX = 2_147_483_647;

// Hard cap on total request-body bytes. This RPC accepts a tiny JSON payload
// (~150 bytes canonical); anything larger is fail-closed regardless of the
// Content-Length header. Applied at the byte-stream level, so multibyte
// content cannot bypass the limit via character count.
export const MAX_REQUEST_BODY_BYTES = 4096;

export const RollbackRequestSchema = z.object({
  project_document_id: z.string().uuid(),
  target_version_number: z.number().int().min(1).max(PG_INT_MAX),
  expected_lock_version: z.number().int().min(0).max(PG_INT_MAX),
}).strict();
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;

export const RollbackResponseSchema = z.object({
  project_document_id: z.string().uuid(),
  new_lock_version: z.number().int().min(0).max(PG_INT_MAX),
  new_version_number: z.number().int().min(1).max(PG_INT_MAX),
}).strict();
export type RollbackResponse = z.infer<typeof RollbackResponseSchema>;

// Closed allowlist for RPC errors. A public error requires BOTH the exact
// SQLSTATE (Postgres error.code) AND the exact machine-code (error.message).
// Any mismatch, unknown key, or missing field maps to generic 500.
//
// Intentionally EXCLUDED (map to 500 as internal invariant violations that
// must be prevented before the RPC executes):
//   28000 + missing_actor_user_id
//   22023 + missing_expected_lock_version
export const RPC_ERROR_ALLOWLIST: Readonly<
  Record<string, { sqlstate: string; status: number }>
> = Object.freeze({
  not_found: { sqlstate: "42704", status: 404 },
  organization_not_active: { sqlstate: "22023", status: 409 },
  project_not_active: { sqlstate: "22023", status: 409 },
  membership_not_active: { sqlstate: "42501", status: 403 },
  insufficient_role: { sqlstate: "42501", status: 403 },
  lock_version_mismatch: { sqlstate: "55P03", status: 409 },
  target_version_not_found: { sqlstate: "42704", status: 404 },
  target_schema_version_incompatible: { sqlstate: "22023", status: 409 },
});

export interface MappedError {
  status: number;
  body: { error: string };
}

export function mapRpcError(err: unknown): MappedError {
  const fallback: MappedError = { status: 500, body: { error: "internal_error" } };
  if (!err || typeof err !== "object") return fallback;
  const e = err as { message?: unknown; code?: unknown };
  if (typeof e.message !== "string") return fallback;
  if (typeof e.code !== "string") return fallback;
  const key = e.message.trim();
  const hit = RPC_ERROR_ALLOWLIST[key];
  if (!hit) return fallback;
  if (hit.sqlstate !== e.code) return fallback;
  return { status: hit.status, body: { error: key } };
}

// Permissive CORS following the standard Supabase Edge Function pattern.
// CORS is NOT a security boundary here; there is no origin allowlist and no
// credentialed cross-origin support. Enforcement of who may invoke this
// endpoint happens through the JWT and the RPC's role checks — never CORS.
export const CORS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

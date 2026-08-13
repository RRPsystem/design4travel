import { z } from "zod";

// PostgreSQL `integer` (int4) upper bound. Values above this overflow the
// column type in the RPC (SQLSTATE 22003). Reject earlier with 400 so the
// client gets an actionable signal instead of a generic 500.
export const PG_INT_MAX = 2_147_483_647;

// Hard cap on total request-body bytes. Seed-docs are scaffolding — a starter
// landing page fits comfortably in a few KB; 64 KB leaves headroom for early
// document types (offerte/roadbook seeds) without opening the door to
// unbounded payloads. Anything larger is fail-closed regardless of the
// Content-Length header. Applied at the byte-stream level, so multibyte
// content cannot bypass the limit via character count.
export const MAX_REQUEST_BODY_BYTES = 65_536;

// Whitelist for document_type. Mirrors chk_document_type in 0002_schema.sql
// and the whitelist inside create_project_and_document_internal in 0011.
// If any of those three lists changes, update all three (there is no shared
// source of truth in Supabase — sync is by convention).
const DOCUMENT_TYPES = [
  "website",
  "offerte",
  "roadbook",
  "brochure",
  "social",
  "document",
] as const;

// Minimum DesignDoc shape. Matches project_documents.chk_doc_shape which
// enforces: object, has 'version', has 'project', has 'pages' as an array
// with at least one entry. The full renderer/Zod validation lives in the
// frontend; the Edge Function only enforces the minimum invariants the DB
// would otherwise reject as a 23514 check_violation (which we would then
// have to map to a generic 500 to avoid leaking shape-details).
const SeedDocSchema = z.object({
  version: z.string().min(1),
  project: z.object({
    documentType: z.enum(DOCUMENT_TYPES),
  }).passthrough(),
  pages: z.array(z.unknown()).min(1),
}).passthrough();

export const CreateRequestSchema = z.object({
  organization_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  document_type: z.enum(DOCUMENT_TYPES),
  schema_version: z.string().min(1).max(64),
  seed_doc: SeedDocSchema,
}).strict();
export type CreateRequest = z.infer<typeof CreateRequestSchema>;

export const CreateResponseSchema = z.object({
  project_id: z.string().uuid(),
  project_document_id: z.string().uuid(),
  lock_version: z.number().int().min(1).max(PG_INT_MAX),
}).strict();
export type CreateResponse = z.infer<typeof CreateResponseSchema>;

// Closed allowlist for RPC errors. A public error requires BOTH the exact
// SQLSTATE (Postgres error.code) AND the exact machine-code (error.message).
// Any mismatch, unknown key, or missing field maps to generic 500.
//
// Intentionally EXCLUDED (map to 500 as internal invariant violations that
// must be prevented before the RPC executes):
//   28000 + missing_actor_user_id  — actor comes from verified JWT
//   22023 + invalid_document_type  — Zod-enum guards this
//   22023 + invalid_name           — Zod-length guards this
//   22023 + invalid_schema_version — Zod-length guards this
//   22023 + invalid_seed_doc       — Zod-object guards this
//   23514 (check_violation)        — chk_doc_shape; means Zod let malformed
//                                    doc through, must never reach client
export const RPC_ERROR_ALLOWLIST: Readonly<
  Record<string, { sqlstate: string; status: number }>
> = Object.freeze({
  organization_not_active: { sqlstate: "22023", status: 409 },
  membership_not_active: { sqlstate: "42501", status: 403 },
  insufficient_role: { sqlstate: "42501", status: 403 },
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

import { z } from "zod";

// PostgreSQL `integer` (int4) upper bound. Values above this overflow the
// column type in the RPC (SQLSTATE 22003). Reject earlier with 400 so the
// client gets an actionable signal instead of a generic 500.
export const PG_INT_MAX = 2_147_483_647;

// Hard cap on total request-body bytes. Real designs grow over time — a
// multipage offerte or roadbook with dozens of nodes and per-output overrides
// can reach the low-hundreds-of-KB range. 512 KB leaves headroom for that
// while still hard-capping runaway payloads (a malformed doc that keeps
// duplicating pages, or an accidental image-as-base64 embed). Applied at the
// byte-stream level so multibyte content cannot bypass the limit via
// character count.
export const MAX_REQUEST_BODY_BYTES = 524_288;

// Whitelist for the seed_doc/doc project.documentType field. Mirrors
// chk_document_type in 0002_schema.sql. If that list changes, update here.
const DOCUMENT_TYPES = [
  "website",
  "offerte",
  "roadbook",
  "brochure",
  "social",
  "document",
] as const;

// Minimum DesignDoc shape. Matches project_documents.chk_doc_shape:
// object, has 'version', has 'project', has 'pages' as an array with at
// least one entry. Full renderer/Zod validation lives in the frontend; the
// Edge Function only enforces the minimum invariants the DB would otherwise
// reject as a 23514 check_violation (which would then have to map to a
// generic 500 to avoid leaking shape-details).
const DocSchema = z.object({
  version: z.string().min(1),
  project: z.object({
    documentType: z.enum(DOCUMENT_TYPES),
  }).passthrough(),
  pages: z.array(z.unknown()).min(1),
}).passthrough();

// Body accepteert nu ÓFWEL document_id (preferred, na multi-doc migratie
// 0014-0016) ÓFWEL project_id (legacy, blijft werken zolang het project
// exact 1 doc heeft). Precies één van beide moet aanwezig zijn — beide
// tegelijk = ambigu = 400.
//
// Frontend-adapters die nog project_id sturen worden hierdoor niet gebroken
// door deze deploy. Nadat de frontend migreert naar document_id kan de
// legacy-tak in een latere revisie verwijderd worden.
export const SaveRequestSchema = z
  .object({
    project_id: z.string().uuid().optional(),
    document_id: z.string().uuid().optional(),
    doc: DocSchema,
    schema_version: z.string().min(1).max(64),
    // Must be ≥ 1 — lock_version is initialised to 1 in project_documents and
    // only ever incremented. A zero here means the client never loaded the
    // document, which is a client bug we surface as 400 rather than 500.
    expected_lock_version: z.number().int().min(1).max(PG_INT_MAX),
  })
  .strict()
  .refine(
    (body) =>
      (body.project_id !== undefined) !== (body.document_id !== undefined),
    { message: "exactly one of project_id or document_id is required" },
  );
export type SaveRequest = z.infer<typeof SaveRequestSchema>;

export const SaveResponseSchema = z.object({
  new_lock_version: z.number().int().min(1).max(PG_INT_MAX),
}).strict();
export type SaveResponse = z.infer<typeof SaveResponseSchema>;

// Closed allowlist for RPC errors. A public error requires BOTH the exact
// SQLSTATE (Postgres error.code) AND the exact machine-code (error.message).
// Any mismatch, unknown key, or missing field maps to generic 500.
//
// Intentionally EXCLUDED (map to 500 as internal invariant violations that
// must be prevented before the RPC executes):
//   28000 + missing_actor_user_id  — actor comes from verified JWT
//   23514 (check_violation)        — chk_doc_shape; Zod must catch first,
//                                    otherwise a shape-leak
export const RPC_ERROR_ALLOWLIST: Readonly<
  Record<string, { sqlstate: string; status: number }>
> = Object.freeze({
  project_not_found: { sqlstate: "42704", status: 404 },
  document_not_found: { sqlstate: "42704", status: 404 },
  organization_not_active: { sqlstate: "22023", status: 409 },
  project_not_active: { sqlstate: "22023", status: 409 },
  membership_not_active: { sqlstate: "42501", status: 403 },
  insufficient_role: { sqlstate: "42501", status: 403 },
  lock_version_mismatch: { sqlstate: "55P03", status: 409 },
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

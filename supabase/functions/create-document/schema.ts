import { z } from "zod";

// PostgreSQL `integer` (int4) upper bound. Values above this overflow the
// column type in the RPC (SQLSTATE 22003). Reject earlier with 400 so the
// client gets an actionable signal instead of a generic 500.
export const PG_INT_MAX = 2_147_483_647;

// Hard cap on total request-body bytes. A seed_doc for a fresh document is
// scaffolding — a starter landing page or offerte-template fits well within
// 64 KB. Anything larger is fail-closed regardless of the Content-Length
// header. Applied at the byte-stream level, so multibyte content cannot
// bypass the limit via character count.
export const MAX_REQUEST_BODY_BYTES = 65_536;

// Whitelist for document_type. Mirrors chk_document_type in 0002_schema.sql
// EN chk_pd_document_type in 0014_multi_document_per_project.sql EN de
// whitelist in create_project_document uit 0016. Als één van deze drie
// lijsten wijzigt, PAS ALLE DRIE aan.
const DOCUMENT_TYPES = [
  "website",
  "offerte",
  "roadbook",
  "brochure",
  "social",
  "document",
] as const;

// Minimum DesignDoc shape. Matches project_documents.chk_doc_shape.
const SeedDocSchema = z.object({
  version: z.string().min(1),
  project: z.object({
    documentType: z.enum(DOCUMENT_TYPES),
  }).passthrough(),
  pages: z.array(z.unknown()).min(1),
}).passthrough();

export const CreateRequestSchema = z.object({
  project_id: z.string().uuid(),
  document_type: z.enum(DOCUMENT_TYPES),
  title: z.string().min(1).max(200),
  schema_version: z.string().min(1).max(64),
  seed_doc: SeedDocSchema,
}).strict();
export type CreateRequest = z.infer<typeof CreateRequestSchema>;

export const CreateResponseSchema = z.object({
  project_document_id: z.string().uuid(),
  lock_version: z.number().int().min(1).max(PG_INT_MAX),
}).strict();
export type CreateResponse = z.infer<typeof CreateResponseSchema>;

// Closed allowlist for RPC errors. Zelfde principe als andere Edge Functions:
// een publieke error vereist EXACT dezelfde SQLSTATE + machinecode. Alles
// wat niet matcht → 500 internal_error (geen shape-leak).
//
// Intentionally EXCLUDED (map to 500 als interne invariant-fouten die vóór
// de RPC voorkomen moeten worden):
//   28000 + missing_actor_user_id  — actor komt uit geverifieerde JWT
//   22023 + invalid_document_type  — Zod-enum vangt dit
//   22023 + invalid_title          — Zod-length vangt dit
//   22023 + invalid_schema_version — Zod-length vangt dit
//   22023 + invalid_seed_doc       — Zod-object vangt dit
//   23514 (check_violation)        — chk_doc_shape; Zod moet dit vangen,
//                                    anders shape-leak
export const RPC_ERROR_ALLOWLIST: Readonly<
  Record<string, { sqlstate: string; status: number }>
> = Object.freeze({
  project_not_active: { sqlstate: "22023", status: 409 },
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

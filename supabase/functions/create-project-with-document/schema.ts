import { z } from "zod";

export const PG_INT_MAX = 2_147_483_647;

// Body-cap: seed_doc + project-metadata past ruim binnen 64 KB.
export const MAX_REQUEST_BODY_BYTES = 65_536;

// Whitelist voor document_type. Mirrort chk_document_type in 0002 +
// chk_pd_document_type in 0014 + de whitelist in de RPC uit 0017.
// Als één van deze wijzigt, PAS ALLE VIER aan.
const DOCUMENT_TYPES = [
  "website",
  "offerte",
  "roadbook",
  "brochure",
  "social",
  "document",
] as const;

const SeedDocSchema = z.object({
  version: z.string().min(1),
  project: z.object({
    documentType: z.enum(DOCUMENT_TYPES),
  }).passthrough(),
  pages: z.array(z.unknown()).min(1),
}).passthrough();

export const CreateRequestSchema = z.object({
  organization_id: z.string().uuid(),
  project_name: z.string().min(1).max(200),
  project_description: z.string().max(2000).optional().nullable(),
  first_document_type: z.enum(DOCUMENT_TYPES),
  first_document_title: z.string().min(1).max(200),
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

// Closed allowlist. Zelfde principe als andere Edge Functions.
// Intentioneel EXCLUDED (map to 500 als interne invariants die vóór de RPC
// moeten worden gepakt):
//   28000 + missing_actor_user_id  — actor komt uit geverifieerde JWT
//   22023 + invalid_project_name   — Zod-length vangt dit
//   22023 + invalid_document_title — Zod-length vangt dit
//   22023 + invalid_document_type  — Zod-enum vangt dit
//   22023 + invalid_schema_version — Zod-length vangt dit
//   22023 + invalid_seed_doc       — Zod-object vangt dit
//   23514 (check_violation)        — chk_doc_shape defence-in-depth,
//                                    zou nooit moeten reachen
export const RPC_ERROR_ALLOWLIST: Readonly<
  Record<string, { sqlstate: string; status: number }>
> = Object.freeze({
  organization_not_active: { sqlstate: "22023", status: 409 },
  membership_not_active: { sqlstate: "42501", status: 403 },
  insufficient_role: { sqlstate: "42501", status: 403 },
  project_quota_exceeded: { sqlstate: "23514", status: 409 },
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

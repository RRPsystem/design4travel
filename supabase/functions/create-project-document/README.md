# create-project-document — Supabase Edge Function

Server-side wrapper around the `public.create_project_and_document_internal(uuid, uuid, text, text, jsonb, text)` RPC (migration `0011`). Verifies the caller's user-JWT, forwards only the trusted `user.id` as `p_actor_user_id`, calls the RPC with a service-role client, and maps a closed allowlist of RPC errors to public HTTP responses.

Bootstrap-only: the RPC is idempotent per organisation. Two concurrent tabs from the same user will each get the same `project_id` and `project_document_id` back — the RPC's advisory-lock serialises them and the second caller sees the first caller's row via the "existing active project" check.

## Contract

**Endpoint (local)**: `POST http://127.0.0.1:54321/functions/v1/create-project-document`
**Auth**: `Authorization: Bearer <user-JWT>` and `apikey: <anon-key>` (both required by the Supabase gateway).
**`verify_jwt = true`** — the platform verifies the JWT before invocation; anon, service_role, invalid, or expired tokens never reach the function.

### Request body

```json
{
  "organization_id": "uuid",
  "name": "Starter Project",
  "document_type": "website",
  "schema_version": "0.1.0",
  "seed_doc": {
    "version": "0.1.0",
    "project": { "documentType": "website", "title": "Starter" },
    "pages": [ { "id": "p1", "root": { "id": "r", "type": "layout-column", "props": {} } } ]
  }
}
```

All five fields are required. Extra keys (including `p_actor_user_id`) cause a 400 — the actor is derived exclusively from the verified JWT. Types are runtime-validated via zod (`.strict()`).

- `name`: 1–200 chars (matches `chk_project_name_length` in `0002_schema.sql`).
- `document_type`: one of `website`, `offerte`, `roadbook`, `brochure`, `social`, `document` (matches `chk_document_type` and the `create_project` RPC whitelist).
- `schema_version`: 1–64 chars.
- `seed_doc`: minimum shape enforced by zod matches `chk_doc_shape` on `project_documents` — object with `version`, `project.documentType` (one of the six values), and non-empty `pages` array. Unknown fields inside `seed_doc` are allowed via `.passthrough()`. The DB-side `chk_doc_shape` re-validates as defence-in-depth; a failure there returns `500 internal_error` (never leaked).

The request body is capped at **65 536 bytes (64 KB)**. Larger requests receive `413 payload_too_large` without any auth, dependency, or database work. The cap is enforced on raw bytes at both the `Content-Length` header (when present, malformed values return `400 invalid_request`) and via a streaming byte counter, so multibyte UTF-8 content cannot bypass it via character count.

### Success response — 200

```json
{
  "project_id": "uuid",
  "project_document_id": "uuid",
  "lock_version": 1
}
```

`lock_version` is `1` for a freshly created document, or the current `project_documents.lock_version` if the RPC returned an existing project (idempotent path — the client can pass this straight to the first `save-document` call).

### Error responses

Body is always exactly `{"error": "<machine_code>"}`. Postgres `details`, `hint`, `code`, or any other backend field never leaks.

| HTTP | `error` | Cause |
|---|---|---|
| 204 | – | Preflight (OPTIONS) |
| 400 | `invalid_json` | Body is not valid JSON |
| 400 | `invalid_request` | Body fails zod validation, contains unknown keys, or has a malformed Content-Length header |
| 401 | `missing_authorization` | No `Authorization: Bearer …` header |
| 401 | `invalid_user_token` | Token maps to no authenticated user (anon key, service_role key, revoked user, wrong `aud`/`role`) |
| 403 | `insufficient_role` | User is not owner/admin/editor of the org |
| 403 | `membership_not_active` | User has no active membership on the org |
| 405 | `method_not_allowed` | Not POST/OPTIONS |
| 409 | `organization_not_active` | Org soft-deleted |
| 413 | `payload_too_large` | Request body exceeds 65 536 bytes (Content-Length or streamed) |
| 500 | `internal_error` | Any DB error, unknown RPC machinecode, SQLSTATE/machinecode mismatch, unexpected exception, or invariant violation (`missing_actor_user_id`, `invalid_document_type`, `invalid_name`, `invalid_schema_version`, `invalid_seed_doc`, `23514` check_violation — all guarded by zod before the RPC, so should never reach the client) |

## Local development

The four checks below use Docker so no host-side Deno install is required.

```bash
# 1. (Re)generate deno.lock with pinned versions
docker run --rm -v "$(pwd)/supabase/functions/create-project-document:/work" \
  -w /work -e DENO_DIR=/work/.cache \
  denoland/deno:2.9.5 deno cache handler.ts index.ts index.test.ts

# 2. Typecheck
docker run --rm -v "$(pwd)/supabase/functions/create-project-document:/work" \
  -w /work -e DENO_DIR=/work/.cache \
  denoland/deno:2.9.5 deno check handler.ts index.ts index.test.ts

# 3. Frozen-lockfile verification (fails on drift)
docker run --rm -v "$(pwd)/supabase/functions/create-project-document:/work" \
  -w /work -e DENO_DIR=/work/.cache \
  denoland/deno:2.9.5 deno cache --frozen handler.ts index.ts index.test.ts

# 4. Run the test suite (must scope to index.test.ts — otherwise Deno
#    discovers .test.ts files inside the npm cache too)
docker run --rm -v "$(pwd)/supabase/functions/create-project-document:/work" \
  -w /work -e DENO_DIR=/work/.cache \
  denoland/deno:2.9.5 deno test --allow-env index.test.ts
```

`.cache/` is caught by the repository-wide `.gitignore` rule; no additional ignore entries are needed.

## Dependencies (exact, pinned)

- `npm:@supabase/supabase-js@2.109.0`
- `npm:zod@3.25.76`

`deno.lock` (committed) pins all resolved dependencies with integrity hashes for the complete transitive graph. Do not upgrade without a follow-up PoC.

The npm-style import (rather than jsr:) is deliberate: the Supabase CLI bundler runs inside a container that cannot always reach `jsr.io` through corporate TLS-intercepting proxies, whereas `registry.npmjs.org` typically passes through. The package is the same either way; the version pin (2.109.0) matches what `apps/app` uses so the wire behaviour is identical to the frontend's Supabase client.

## Files

- `index.ts` — production entrypoint; injects real dependencies into `makeHandler`.
- `handler.ts` — pure `makeHandler({makeUserClient, makeAdmin}) → Request → Response`. Fully testable.
- `schema.ts` — zod schemas for request + response, closed SQLSTATE+machinecode allowlist, CORS headers.
- `index.test.ts` — Deno-native tests (unit + integration with stubs). No network, no real supabase-js roundtrip.
- `deno.json` — import map with exact version pins.
- `deno.lock` — committed lockfile.

## Deployment (out of scope for this local implementation)

Remote deploy is a separate, explicitly approved step. It requires:

1. Migration `0011_rpc_create_project_and_document.sql` to be applied to the target project.
2. `supabase functions deploy create-project-document --project-ref <dev-project-ref>`.

Neither is executed as part of this local implementation.

# save-document — Supabase Edge Function

Server-side wrapper around the `public.save_document_internal(uuid, uuid, jsonb, text, integer)` RPC (migration `0008`). Verifies the caller's user-JWT, forwards only the trusted `user.id` as `p_actor_user_id`, calls the RPC with a service-role client, and maps a closed allowlist of RPC errors to public HTTP responses.

## Contract

**Endpoint (local)**: `POST http://127.0.0.1:54321/functions/v1/save-document`
**Auth**: `Authorization: Bearer <user-JWT>` and `apikey: <anon-key>` (both required by the Supabase gateway).
**`verify_jwt = true`** — the platform verifies the JWT before invocation; anon, service_role, invalid, or expired tokens never reach the function.

### Request body

```json
{
  "project_id": "uuid",
  "doc": {
    "version": "0.1.0",
    "project": { "documentType": "website", "title": "Landing" },
    "pages": [ { "id": "p1", "root": { "id": "r", "type": "layout-column", "props": {} } } ]
  },
  "schema_version": "0.1.0",
  "expected_lock_version": 1
}
```

All four fields are required. Extra keys (including `p_actor_user_id`) cause a 400 — the actor is derived exclusively from the verified JWT. Types are runtime-validated via zod (`.strict()`).

- `expected_lock_version`: integer, `1 ≤ n ≤ 2147483647` (`project_documents.lock_version` starts at 1 and increments; a client sending 0 has never loaded the document, which is a client bug — surfaced as 400).
- `schema_version`: 1–64 chars.
- `doc`: minimum shape enforced by zod mirrors `chk_doc_shape` on `project_documents` — object with `version`, `project.documentType` (whitelist), and non-empty `pages`. Unknown fields inside `doc` are allowed via `.passthrough()`. DB-side `chk_doc_shape` re-validates as defence-in-depth; a failure there returns `500 internal_error` (never leaked).

The request body is capped at **524 288 bytes (512 KB)**. Larger requests receive `413 payload_too_large` without any auth, dependency, or database work. The cap is enforced on raw bytes at both the `Content-Length` header (when present, malformed values return `400 invalid_request`) and via a streaming byte counter, so multibyte UTF-8 content cannot bypass it via character count.

### Success response — 200

```json
{ "new_lock_version": 2 }
```

`new_lock_version` is the incremented value the client must send as `expected_lock_version` on the next save. `save_document_internal` returns `integer` (scalar); the Edge Function wraps it in a JSON object so the wire format is stable across future RPC changes.

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
| 404 | `project_not_found` | `project_id` does not exist |
| 404 | `document_not_found` | Project exists but has no `project_documents` row — normally impossible in the standard bootstrap flow; may indicate a race with `soft_delete_project` cascade or a direct DB mutation |
| 405 | `method_not_allowed` | Not POST/OPTIONS |
| 409 | `lock_version_mismatch` | `expected_lock_version` ≠ current `project_documents.lock_version` — another writer bumped the doc; client must reload and retry |
| 409 | `organization_not_active` | Org soft-deleted |
| 409 | `project_not_active` | Project soft-deleted |
| 413 | `payload_too_large` | Request body exceeds 524 288 bytes (Content-Length or streamed) |
| 500 | `internal_error` | Any other DB error, unknown RPC machinecode, SQLSTATE/machinecode mismatch, unexpected exception, or invariant violation (`missing_actor_user_id`, `23514` check_violation — should never reach the client) |

## Local development

The four checks below use Docker so no host-side Deno install is required.

```bash
# 1. (Re)generate deno.lock with pinned versions
docker run --rm -v "$(pwd)/supabase/functions/save-document:/work" \
  -w /work -e DENO_DIR=/work/.cache \
  denoland/deno:2.9.5 deno cache handler.ts index.ts index.test.ts

# 2. Typecheck
docker run --rm -v "$(pwd)/supabase/functions/save-document:/work" \
  -w /work -e DENO_DIR=/work/.cache \
  denoland/deno:2.9.5 deno check handler.ts index.ts index.test.ts

# 3. Frozen-lockfile verification (fails on drift)
docker run --rm -v "$(pwd)/supabase/functions/save-document:/work" \
  -w /work -e DENO_DIR=/work/.cache \
  denoland/deno:2.9.5 deno cache --frozen handler.ts index.ts index.test.ts

# 4. Run the test suite (must scope to index.test.ts — otherwise Deno
#    discovers .test.ts files inside the npm cache too)
docker run --rm -v "$(pwd)/supabase/functions/save-document:/work" \
  -w /work -e DENO_DIR=/work/.cache \
  denoland/deno:2.9.5 deno test --allow-env index.test.ts
```

## Dependencies (exact, pinned)

- `npm:@supabase/supabase-js@2.109.0`
- `npm:zod@3.25.76`

`deno.lock` (committed) pins all resolved dependencies with integrity hashes for the complete transitive graph.

The npm-style import (rather than jsr:) is deliberate: the Supabase CLI bundler runs inside a container that cannot always reach `jsr.io` through corporate TLS-intercepting proxies, whereas `registry.npmjs.org` typically passes through. Same package, same behaviour; the version pin (2.109.0) matches `apps/app`.

## Files

- `index.ts` — production entrypoint; injects real dependencies into `makeHandler`.
- `handler.ts` — pure `makeHandler({makeUserClient, makeAdmin}) → Request → Response`. Fully testable.
- `schema.ts` — zod schemas for request + response, closed SQLSTATE+machinecode allowlist, CORS headers.
- `index.test.ts` — Deno-native tests (unit + integration with stubs). No network, no real supabase-js roundtrip.
- `deno.json` — import map with exact version pins.
- `deno.lock` — committed lockfile.

## Deployment (out of scope for this local implementation)

Remote deploy is a separate, explicitly approved step. `save_document_internal` (migration `0008`) is already in the production dev-project. This function only needs:

`supabase functions deploy save-document --project-ref <dev-project-ref>`.

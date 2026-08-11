# rollback-document — Supabase Edge Function

Server-side wrapper around the `public.rollback_to_version(uuid, uuid, integer, integer)` RPC (migration `0010`). Verifies the caller's user-JWT, forwards only the trusted `user.id` as `p_actor_user_id`, calls the RPC with a service-role client, and maps a closed allowlist of RPC errors to public HTTP responses.

## Contract

**Endpoint (local)**: `POST http://127.0.0.1:54321/functions/v1/rollback-document`
**Auth**: `Authorization: Bearer <user-JWT>` and `apikey: <anon-key>` (both required by the Supabase gateway).
**`verify_jwt = true`** — the platform verifies the JWT before invocation; anon, service_role, invalid, or expired tokens never reach the function.

### Request body

```json
{
  "project_document_id": "uuid",
  "target_version_number": 3,
  "expected_lock_version": 2
}
```

All three fields are required. Extra keys (including `p_actor_user_id`) cause a 400 — the actor is derived exclusively from the verified JWT. Types are runtime-validated via zod (`.strict()`).

- `target_version_number`: integer, `1 ≤ n ≤ 2147483647` (PostgreSQL `integer` upper bound).
- `expected_lock_version`: integer, `0 ≤ n ≤ 2147483647` (idem).

The request body is capped at **4096 bytes**. Larger requests receive `413 payload_too_large` without any auth, dependency, or database work. The cap is enforced on raw bytes at both the `Content-Length` header (when present, malformed values return `400 invalid_request`) and via a streaming byte counter, so multibyte UTF-8 content cannot bypass it via character count.

### Success response — 200

```json
{
  "project_document_id": "uuid",
  "new_lock_version": 3,
  "new_version_number": 7
}
```

### Error responses

Body is always exactly `{"error": "<machine_code>"}`. Postgres `details`, `hint`, `code`, or any other backend field never leaks.

| HTTP | `error` | Cause |
|---|---|---|
| 204 | – | Preflight (OPTIONS) |
| 400 | `invalid_json` | Body is not valid JSON |
| 400 | `invalid_request` | Body fails zod validation or contains unknown keys |
| 401 | `missing_authorization` | No `Authorization: Bearer …` header |
| 401 | `invalid_user_token` | Token maps to no authenticated user (anon key, service_role key, revoked user, wrong `aud`/`role`) |
| 403 | `insufficient_role` | User is not owner/admin/editor |
| 403 | `membership_not_active` | User has no active membership on the org |
| 404 | `not_found` | Parent document not found |
| 404 | `target_version_not_found` | Requested `target_version_number` does not exist |
| 405 | `method_not_allowed` | Not POST/OPTIONS |
| 409 | `lock_version_mismatch` | `expected_lock_version` ≠ current lock |
| 409 | `organization_not_active` | Org soft-deleted |
| 409 | `project_not_active` | Project soft-deleted |
| 409 | `target_schema_version_incompatible` | Target version's `schema_version` differs from current |
| 413 | `payload_too_large` | Request body exceeds 4096 bytes (Content-Length or streamed) |
| 500 | `internal_error` | Any other DB error, unknown RPC code, SQLSTATE/machine-code mismatch, unexpected exception, or invariant violation (`missing_actor_user_id`, `missing_expected_lock_version` should never reach the client) |

## Local development

The three checks below use Docker so no host-side Deno install is required.

```bash
# 1. (Re)generate deno.lock with pinned versions
docker run --rm -v "$(pwd)/supabase/functions/rollback-document:/work" \
  -w /work -e DENO_DIR=/work/.cache \
  denoland/deno:2.9.5 deno cache handler.ts index.ts index.test.ts

# 2. Typecheck
docker run --rm -v "$(pwd)/supabase/functions/rollback-document:/work" \
  -w /work -e DENO_DIR=/work/.cache \
  denoland/deno:2.9.5 deno check handler.ts index.ts index.test.ts

# 3. Frozen-lockfile verification (fails on drift)
docker run --rm -v "$(pwd)/supabase/functions/rollback-document:/work" \
  -w /work -e DENO_DIR=/work/.cache \
  denoland/deno:2.9.5 deno cache --frozen handler.ts index.ts index.test.ts

# 4. Run the test suite (must scope to index.test.ts — otherwise Deno
#    discovers .test.ts files inside the npm cache too)
docker run --rm -v "$(pwd)/supabase/functions/rollback-document:/work" \
  -w /work -e DENO_DIR=/work/.cache \
  denoland/deno:2.9.5 deno test --allow-env index.test.ts

# 5. Bundle as eszip (production-packaging check)
docker run --rm -v "$(pwd)/supabase/functions/rollback-document:/work" \
  -w /work supabase/edge-runtime:v1.73.13 \
  bundle --entrypoint /work/index.ts --output /work/.cache/bin.eszip
```

`.cache/` is caught by the repository-wide `.gitignore` rule; no additional ignore entries are needed.

## Local runtime check

```bash
supabase start                                  # if not already running
supabase functions serve rollback-document      # BEWUST zonder --no-verify-jwt

# Preflight
curl -sSI -X OPTIONS \
  http://127.0.0.1:54321/functions/v1/rollback-document

# POST without Authorization → platform 401 (proves verify_jwt = true)
curl -sSI -X POST \
  -H "apikey: <ANON_KEY from supabase status -o env>" \
  http://127.0.0.1:54321/functions/v1/rollback-document
```

For a full happy-path test locally, obtain a user-JWT via the local GoTrue endpoint (sign-up + `access_token`) and pass it in `Authorization: Bearer …`. The complete unit and integration test suite in `index.test.ts` already covers every branch with stub clients — see `deno test` above.

## Dependencies (exact, pinned)

- `jsr:@supabase/supabase-js@2.112.2`
- `npm:zod@3.25.76`

`deno.lock` (committed) pins all resolved dependencies with integrity hashes for the complete transitive graph. Do not upgrade without a follow-up PoC.

## Files

- `index.ts` — production entrypoint; injects real dependencies into `makeHandler`.
- `handler.ts` — pure `makeHandler({makeUserClient, makeAdmin}) → Request → Response`. Fully testable.
- `schema.ts` — zod schemas for request + response, closed SQLSTATE+machine-code allowlist, CORS headers.
- `index.test.ts` — Deno-native tests (unit + integration with stubs). No network, no real supabase-js roundtrip.
- `deno.json` — import map with exact version pins.
- `deno.lock` — committed lockfile.

## Deployment (out of scope for this local implementation)

Remote deploy is a separate, explicitly approved step. It requires:

1. Migration `0010_rpc_rollback_document.sql` to be applied to the target project (`supabase db push --linked`).
2. `supabase functions deploy rollback-document --project-ref <dev-project-ref>`.

Neither is executed as part of A3.2 local implementation.

# create-document

Nieuwe document toevoegen aan een BESTAAND project. Verschilt van
`create-project-document` (die is bootstrap-only + idempotent per org).

- `POST /functions/v1/create-document`
- Auth: user-JWT in `Authorization` header
- Body: `{project_id, document_type, title, seed_doc, schema_version}`
- Response 200: `{project_document_id, lock_version}`

Wraps RPC `create_project_document` (migratie 0016). RPC is service_role-only;
deze Edge Function verifieert de JWT en forwards `p_actor_user_id` vanuit
de geverifieerde token.

## Deploy

```bash
supabase functions deploy create-document --project-ref <dev>
```

Geen secrets nodig — gebruikt de standaard Supabase-Edge-Function env vars
(SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY).

## Error mapping

- 400 `invalid_request` / `invalid_json` — Zod-fout op body.
- 401 `missing_authorization` / `invalid_user_token`.
- 403 `insufficient_role` — user is member maar geen owner/admin/editor.
- 403 `membership_not_active` — user niet meer active member van de org.
- 405 `method_not_allowed`.
- 409 `project_not_active` — target project bestaat niet of is gearchiveerd.
- 409 `organization_not_active` — org gearchiveerd.
- 413 `payload_too_large` — body > 64 KB.
- 500 `internal_error` — alle andere fouten (defence-in-depth, geen shape-leak).

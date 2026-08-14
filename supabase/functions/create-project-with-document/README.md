# create-project-with-document

Atomische creatie van een nieuw project + eerste document in één transactie.

Bedoeld voor de "Nieuw project"-flow in het dashboard. Waarom niet twee losse
calls (`create_project` + `create-document`)? Als de tweede faalt blijft er
een leeg project achter — niet acceptabel voor de UX.

- `POST /functions/v1/create-project-with-document`
- Auth: user-JWT in `Authorization` header
- Body:
  ```json
  {
    "organization_id": "uuid",
    "project_name": "Mijn nieuwe reis",
    "project_description": "optioneel",
    "first_document_type": "website",
    "first_document_title": "Homepagina",
    "seed_doc": { "version": "0.1.0", "project": {...}, "pages": [...] },
    "schema_version": "0.1.0"
  }
  ```
- Response 200:
  ```json
  {
    "project_id": "uuid",
    "project_document_id": "uuid",
    "lock_version": 1
  }
  ```

Wraps de nieuwe RPC `create_project_with_first_document` uit migratie 0017.
RPC is service_role-only; deze Edge Function verifieert JWT en forwards
`p_actor_user_id` uit de geverifieerde token.

## Verschil met `create-project-document` Edge Function

- `create-project-document` (bestaand, migratie 0011): **bootstrap-only**,
  idempotent per organisatie — retourneert bestaand project+doc als er al één
  is.
- `create-project-with-document` (deze, migratie 0017): **deliberate create**,
  altijd nieuw project (tot quota 20/org). Voor de "Nieuw project"-knop in
  het dashboard.

## Deploy

```bash
supabase functions deploy create-project-with-document --project-ref <dev>
```

Geen secrets nodig — gebruikt standaard Supabase-Edge-Function env vars.

## Error mapping

- 400 `invalid_request` / `invalid_json` — Zod-fout op body.
- 401 `missing_authorization` / `invalid_user_token`.
- 403 `insufficient_role` / `membership_not_active`.
- 405 `method_not_allowed`.
- 409 `organization_not_active` / `project_quota_exceeded` (20 actieve
  projecten per org).
- 413 `payload_too_large` — body > 64 KB.
- 500 `internal_error` — alles wat niet in de allowlist zit.

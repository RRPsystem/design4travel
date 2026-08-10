# Concurrency race-tests (opt-in)

pgTAP draait single-transaction en kan geen echte races triggeren. De scripts hier
starten twee `psql`-sessies parallel om de invarianten uit het security-ontwerp
runtime te bewijzen.

## Wanneer draaien

- **Alleen** tegen een lokale of dev-Supabase-stack (nooit prod).
- Nadat de migrations schoon zijn geladen (`supabase db reset`).
- Voor elke wijziging aan een RPC in `0005_rpc_org_and_project.sql`, `0006_rpc_membership.sql`, `0007_rpc_invitations.sql` of `0008_rpc_documents.sql`.

## Vereisten

- `psql` in PATH
- `DATABASE_URL` (zie `supabase status`, veld "DB URL") als env-var of via `-h/-p/-U`
- Bash

## Draaien

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:54322/postgres"
cd supabase/tests/concurrency
for s in c*.sh; do echo "=== $s ==="; bash "$s" || echo "!! $s FAILED"; done
```

Elk script eindigt met exit-code 0 (invariant behouden) of 1 (invariant geschonden).

## Scripts (compleet — 12 stuks)

| Script | Race | Verwacht |
|---|---|---|
| c01 | Twee owners `remove_member` elkaar | 1 slaagt, 1 raise `cannot_remove_last_owner`; eindtelling actieve owners = 1 |
| c02 | Twee owners `leave_organization` | Idem |
| c05 | `save_document_internal` vs `remove_member` op dezelfde user | Één wint via FOR UPDATE-lock; geen doc-write door verwijderde user |
| c07 | `save_document_internal` vs `soft_delete_project` | Geen doc-write op deleted project |
| c10 | Twee `accept_invitation` met zelfde token | 1 slaagt, 1 raise `invitation_invalid_expired_or_email_mismatch` |
| c11 | `accept_invitation` vs `soft_delete_organization` | Serialisatie via FOR SHARE/FOR UPDATE op org |
| c29 | `accept_invitation` vs `revoke_invitation` | Één wint atomair |
| c33 | `change_member_role(B→admin)` (A) vs `leave_organization` (B) | Beide paden houden ≥1 actieve owner |
| c40 | `create_document_snapshot` vs `remove_member` (op snapshot-user) | Snapshot-first slaagt; remove-first blokkeert snapshot met `membership_not_active` |
| c41 | `create_document_snapshot` vs `soft_delete_project` | Snapshot-first slaagt; delete-first blokkeert snapshot met `project_not_active` |
| c42 | `create_document_snapshot` vs `soft_delete_organization` | Snapshot-first slaagt; delete-first blokkeert snapshot met `organization_not_active` |
| c43 | `create_document_snapshot` vs `save_document_internal` | Beide slagen (zelfde lockketen serialiseert); doc_lock=2, versions=1 |

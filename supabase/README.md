# Supabase — design4.travel

Deze map bevat de databaselaag voor fase 2A: migrations, RLS-policies, RPCs, tests en lokale Supabase-configuratie. **Nog niet gekoppeld aan een remote project.**

## Wat hier staat

```
supabase/
├── config.toml                       # lokale Supabase-config (dev)
├── migrations/                       # 9 migrations, volgorde 0001 → 0009
│   ├── 0001_bootstrap_grants.sql
│   ├── 0002_schema.sql
│   ├── 0003_helpers_and_triggers.sql
│   ├── 0004_rls_and_grants.sql
│   ├── 0005_rpc_org_and_project.sql
│   ├── 0006_rpc_membership.sql
│   ├── 0007_rpc_invitations.sql
│   ├── 0008_rpc_documents.sql
│   └── 0009_auth_hooks.sql
├── seed.sql                          # test-helper (tests.sign_in_as); alleen lokaal
├── tests/database/                   # pgTAP tests (worden gepikt door supabase test db)
│   ├── 00_setup.sql
│   ├── 01_privilege_snapshot.sql
│   ├── 02_rls_tenant_isolation.sql
│   ├── 03_membership_invariants.sql
│   ├── 04_projects_and_invitations.sql
│   ├── 05_documents.sql
│   ├── 06_quotas.sql
│   ├── 07_invitations_extra.sql
│   ├── 08_profiles_visibility.sql
│   └── 09_external_org_ref.sql
├── scripts/concurrency/              # opt-in race-tests (bash+psql, NIET onder tests/)
│   ├── README.md
│   ├── _seed.sql
│   ├── c01_two_owners_remove_each_other.sh
│   ├── c02_two_owners_leave.sh
│   ├── c05_save_vs_remove_member.sh
│   ├── c07_save_vs_soft_delete_project.sh
│   ├── c10_two_accepts_same_token.sh
│   ├── c11_accept_vs_soft_delete_org.sh
│   ├── c29_accept_vs_revoke.sh
│   ├── c33_owner_change_vs_leave.sh
│   ├── c40_snapshot_vs_remove_member.sh
│   ├── c41_snapshot_vs_soft_delete_project.sh
│   ├── c42_snapshot_vs_soft_delete_organization.sh
│   └── c43_snapshot_vs_save.sh
└── README.md                         # dit bestand
```

## Migration-volgorde en dependencies

Volgorde is strikt — later-genummerde migrations verwijzen naar objecten uit eerdere:

1. **0001** — bootstrap: `revoke all` + `alter default privileges`
2. **0002** — schema: tabellen, indexes, constraints (partial UNIQUE via `CREATE UNIQUE INDEX ... WHERE`)
3. **0003** — helpers: `is_active_org_member`, `active_org_role`, `count_active_owners`, `set_updated_at`, `reject_mutation` + triggers
4. **0004** — RLS: enable+force op alle 9 tabellen, SELECT-policies, column-scoped UPDATE-grants
5. **0005** — RPCs voor org+project: create/soft-delete/set-external-ref
6. **0006** — RPCs voor membership: change_role, remove, leave, restore (allen FOR UPDATE op org)
7. **0007** — RPCs voor invitations: invite (token-hash), accept, revoke (canonieke lockvolgorde)
8. **0008** — RPCs voor documenten: create_document_snapshot (authenticated), save_document_internal (service_role only)
9. **0009** — auth-triggers: auto-profile + personal-org + owner-membership bij nieuwe user

## Lokaal draaien

**Vereist:** Docker Desktop (voor `supabase start`), Supabase CLI ≥ 2.

```bash
# In project-root
supabase start                # Booten van Postgres + Auth + Studio
supabase db reset             # Draait alle 9 migrations op een lege DB
supabase test db              # Draait pgTAP tests uit tests/database/
```

Bij `supabase status` verschijnen o.a.:
- DB URL: `postgresql://postgres:postgres@localhost:54322/postgres`
- Studio URL: `http://localhost:54323`
- Inbucket (magic-link inbox): `http://localhost:54324`

**Concurrency-tests** (aparte stap, opt-in — vereist draaiende DB):

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:54322/postgres"
cd supabase/scripts/concurrency
./c01_two_owners_remove_each_other.sh
./c02_two_owners_leave.sh
./c10_two_accepts_same_token.sh
./c29_accept_vs_revoke.sh
```

Elk script exit 0 bij pass, 1 bij invariant-violation.

## Rollback / herstel

- **Lokaal:** `supabase db reset` gooit de DB weg en herbouwt from scratch. Effectief een volledige rollback.
- **Per-migration rollback:** Supabase migrations zijn forward-only; er zijn geen `.down.sql`-tegenhangers. Herstel loopt via:
  1. Nieuwe migration `0010_revert_XYZ.sql` die de betreffende `create table` / `create policy` / `create function` weer `drop`t.
  2. Of `supabase db reset` (lokaal) / `pg_restore` van backup (remote).
- **Remote productie:** Supabase maakt automatisch dagelijkse backups (retention hangt af van tier). Vóór elke prod-deploy: bevestig laatste backup-timestamp.

## Quota versus rate limits

Fase 2A gebruikt twee verschillende beperkingsmechanismen — **niet door elkaar halen**:

| Actie | Type | Waarde | Implementatie |
|---|---|---|---|
| `create_organization` | **Harde quota** | Max 5 actieve memberships per user (personal + gecreëerd + geaccepteerd) | Advisory lock `membership_set:<user_id>` + `active_membership_count()` check |
| `create_project` | **Harde quota** | Max 20 actieve projecten per organisatie | Advisory lock `project_set:<org_id>` + `active_project_count()` check |
| `accept_invitation` | **Harde quota** (idem create_organization) | Max 5 actieve memberships per user | Zelfde lock + check op accepterende user |
| `restore_member` | **Harde quota** (idem) | Max 5 op target user | Lock + check op TARGET user |
| `invite_member` | **Rate limit** | Max 30 uitnodigingen per uur PER ORGANISATIE | `rate_limit_counters` tabel, `scope_id = organization_id` |

Advisory locks zijn transaction-scoped (`pg_advisory_xact_lock`), waardoor twee gelijktijdige `create_organization`-calls van dezelfde user serialiseren en de quota-check consistent is.

## Security-aannames

Deze migrations gaan uit van het definitief goedgekeurde ontwerp uit de security-rondes. Kernaannames:

1. **RLS is de primaire client-side beveiliging.** Elke client (anon of authenticated) is aan alle RLS-policies onderworpen.
2. **`service_role` staat uitsluitend in Edge-Function-runtime-env**, nooit in de frontend-bundle, nooit in Git.
3. **`save_document_internal` heeft EXECUTE alleen voor `service_role`** — client-writes op documenten kunnen niet Zod-validatie omzeilen.
4. **Elke owner-mutatie neemt FOR UPDATE op de organizations-rij**, waardoor last-owner-invariant race-vrij is per organisatie.
5. **Invitation-tokens leven alleen als SHA-256-hash in de DB.** Klartext-token wordt éénmalig door `invite_member` geretourneerd en moet door de caller (Edge Function) direct in de invite-mail worden verwerkt en dan uit het geheugen verwijderd.
6. **`created_by`, `deleted_at`, `external_org_ref` en `token_hash` zijn immutable via directe UPDATE** — kolomrechten intrekken plus mutatie via RPCs.
7. **Auth-role-check overal via `active_org_role()`**, die naar zowel `deleted_at` op membership als op organizations kijkt. Soft-deleted orgs verstoppen automatisch alles. RPCs die deze helper aanroepen combineren de check ALTIJD met een expliciete `is null`-guard, omdat `NULL not in (...)` in PL/pgSQL evalueert tot NULL en `if NULL then` = false — zonder guard zou een non-member de raise stilletjes overslaan.
8. **Trigger-only functies** (`handle_new_auth_user`, `reject_mutation`, `set_updated_at`) hebben EXECUTE expliciet ingetrokken van `PUBLIC`. Ze draaien uitsluitend als trigger-callback onder het owner-account (postgres); een client hoeft ze nooit rechtstreeks aan te roepen.

## Uitvoering (lokaal — geverifieerd)

Blok A1 is lokaal end-to-end gedraaid en groen:

- ✅ 9 migrations idempotent toegepast via `supabase db reset` (2× vanaf leeg).
- ✅ `supabase test db`: **10 files, 79 tests, 0 failures**.
- ✅ 12 concurrency-scripts: **12 PASS, 0 FAIL** (draaien via lokaal `psql`).
- ✅ `supabase db lint --schema public`: **No schema errors**.
- ✅ Privileges gecontroleerd: `anon` en `PUBLIC` hebben nul EXECUTE-grants op `public.*`; `authenticated` heeft rechtstreekse EXECUTE op **18 van de 22** public-functies (13 RPCs + 5 helpers die door RLS-policies en RPCs inline worden aangeroepen); trigger-functies (`handle_new_auth_user`, `reject_mutation`, `set_updated_at`) en `save_document_internal` uitsluitend bij `postgres` + `service_role`. Alle grants zijn direct — geen role-inheritance (`authenticated` is nergens lid van via `pg_auth_members`).
- ⚠ Geen remote Supabase-project aangemaakt — blijft aan blok A2 gekoppeld.

## Volgende stappen (blok A1 goedgekeurd — nog niet gestart)

- **A2** — remote dev-project aanmaken (`supabase projects create --region eu-central-1 --org …`), migrations pushen, tests draaien. **Niet aangeraakt in A1**; wacht op expliciet akkoord.
- **A3** — Edge Functions (`save-document`, `rollback-document`, `invite-mailer`).
- **B–H** — frontend-schermen (auth, org-switcher, project-lijst, doc-editor-koppeling).

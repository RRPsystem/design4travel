-- 01_privilege_snapshot.sql
-- SEC-1a/b/c: verifieer dat `authenticated`, `anon` en `PUBLIC` uitsluitend de
-- expliciet toegekende rechten hebben. Elke drift versus deze snapshot = testfail.

begin;
select plan(9);

--------------------------------------------------------------------------------
-- SEC-1a: table_privileges — geen anon-toegang
--------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from information_schema.table_privileges
     where grantee = 'anon' and table_schema = 'public'),
  0,
  'anon has zero table privileges in public'
);

--------------------------------------------------------------------------------
-- SEC-1a: `authenticated` SELECT-tables — exact deze set
-- (organization_invitations gebruikt column-scoped SELECT en verschijnt niet
--  in table_privileges; die wordt in SEC-1b geverifieerd.)
--------------------------------------------------------------------------------
select bag_eq(
  $$ select table_name::text
       from information_schema.table_privileges
       where grantee = 'authenticated' and table_schema = 'public'
         and privilege_type = 'SELECT'
       group by table_name $$,
  $$ values
       ('profiles'),
       ('organizations'),
       ('organization_members'),
       ('projects'),
       ('project_documents'),
       ('project_document_versions'),
       ('document_data_snapshots') $$,
  'authenticated has TABLE-scoped SELECT on 7 tables (organization_invitations is column-scoped, no rate_limit_counters)'
);

-- SEC-1a extra: organization_invitations moet WEL column-scoped SELECT hebben
select ok(
  exists (
    select 1 from information_schema.column_privileges
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'organization_invitations'
      and privilege_type = 'SELECT'
  ),
  'organization_invitations heeft column-scoped SELECT (whitelist zonder token_hash)'
);
select ok(
  not exists (
    select 1 from information_schema.column_privileges
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'organization_invitations'
      and column_name = 'token_hash'
      and privilege_type = 'SELECT'
  ),
  'token_hash-kolom is NIET in de SELECT-whitelist'
);

--------------------------------------------------------------------------------
-- SEC-1a: `authenticated` heeft GEEN INSERT/UPDATE/DELETE-tabelrecht
-- (kolom-UPDATE-grants tellen niet mee in table_privileges)
--------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from information_schema.table_privileges
     where grantee = 'authenticated' and table_schema = 'public'
       and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')),
  0,
  'authenticated has no table-wide INSERT/UPDATE/DELETE on public.*'
);

--------------------------------------------------------------------------------
-- SEC-1b: kolom-UPDATE-grants — exact deze set voor `authenticated`
--------------------------------------------------------------------------------
select bag_eq(
  $$ select (table_name || '.' || column_name)::text
       from information_schema.column_privileges
       where grantee = 'authenticated' and table_schema = 'public'
         and privilege_type = 'UPDATE' $$,
  $$ values
       ('profiles.display_name'),
       ('profiles.avatar_url'),
       ('organizations.name'),
       ('organizations.slug'),
       ('organizations.description'),
       ('projects.name'),
       ('projects.description'),
       ('projects.document_type') $$,
  'column-scoped UPDATE grants match whitelist (no updated_at/deleted_at/created_by/external_org_ref/token_hash)'
);

--------------------------------------------------------------------------------
-- SEC-1c: routine_privileges — save_document_internal is NIET aanroepbaar door
--          authenticated/anon/PUBLIC
--------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from information_schema.routine_privileges
     where routine_schema = 'public'
       and routine_name   = 'save_document_internal'
       and grantee in ('authenticated','anon','PUBLIC')),
  0,
  'save_document_internal has NO EXECUTE grant for authenticated/anon/PUBLIC'
);

--------------------------------------------------------------------------------
-- SEC-1c: `anon` heeft geen enkele EXECUTE-grant op public-functies
--------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from information_schema.routine_privileges
     where routine_schema = 'public' and grantee = 'anon'),
  0,
  'anon has zero EXECUTE grants on public.*'
);

--------------------------------------------------------------------------------
-- SEC-1c: `PUBLIC` heeft ook geen enkele EXECUTE-grant op public-functies
-- (defense-in-depth: alter default privileges (0001) intrekt future functions,
--  en de drie trigger-functies handle_new_auth_user / reject_mutation /
--  set_updated_at zijn expliciet revoked in 0003 en 0009.)
--------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from information_schema.routine_privileges
     where routine_schema = 'public' and grantee = 'PUBLIC'),
  0,
  'PUBLIC has zero EXECUTE grants on public.*'
);

select * from finish();
rollback;

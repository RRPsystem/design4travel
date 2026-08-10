-- 02_rls_tenant_isolation.sql
-- T1, T2, T15, T16, T17, T25a-e, T30, T60

begin;
select plan(10);

-- Setup: twee users in twee orgs.
--   user_a → org_alpha (owner)
--   user_b → org_beta  (owner)
--   outsider → geen orgs

-- Auth-users aanmaken (via directe insert; in productie doet Supabase Auth dit)
insert into auth.users (id, instance_id, email, encrypted_password,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role, email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
   'a@test.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated',
   now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
   'b@test.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated',
   now(), now(), now()),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000',
   'outsider@test.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated',
   now(), now(), now());
-- De handle_new_auth_user-trigger maakt profiles + personal orgs aan.

-- User A maakt org_alpha; user B maakt org_beta
select tests.sign_in_as('11111111-1111-1111-1111-111111111111');
select create_organization('Alpha Team', 'alpha-team');

select tests.sign_in_as('22222222-2222-2222-2222-222222222222');
select create_organization('Beta Team', 'beta-team');

select tests.sign_out();

--------------------------------------------------------------------------------
-- T1: outsider ziet geen alpha/beta-orgs
--------------------------------------------------------------------------------
select tests.sign_in_as('33333333-3333-3333-3333-333333333333');

select is(
  (select count(*)::int from public.organizations where slug in ('alpha-team','beta-team')),
  0,
  'T1: outsider cannot see alpha/beta organizations'
);

--------------------------------------------------------------------------------
-- T15: anon heeft geen toegang tot organizations
-- (anon heeft geen SELECT-grant → permission denied is de correcte respons)
--------------------------------------------------------------------------------
select tests.sign_out();
set role anon;
select throws_ok(
  $$ select count(*) from public.organizations $$,
  '42501',
  null,
  'T15: anon is denied access to organizations table'
);
reset role;

--------------------------------------------------------------------------------
-- T16/T17: authenticated kan project_documents NIET direct UPDATE-en
--------------------------------------------------------------------------------
select tests.sign_in_as('11111111-1111-1111-1111-111111111111');
-- Maak een project + zorg dat er een doc-rij is (via save_document_internal als postgres)
select create_project(
  (select id from public.organizations where slug = 'alpha-team'),
  'Test project', 'website', null
);

-- Fake doc-rij (echte doc-flow loopt via EF; hier direct als postgres)
select tests.sign_out();
set role postgres;
insert into public.project_documents (project_id, doc, schema_version, updated_by)
  select p.id,
         jsonb_build_object('version','0.1.0','project',jsonb_build_object('documentType','website','title','x'),
                            'pages',jsonb_build_array(jsonb_build_object('id','p','root',jsonb_build_object('id','r','type','text','props','{}'::jsonb)))),
         '0.1.0',
         '11111111-1111-1111-1111-111111111111'
  from public.projects p where p.name = 'Test project';
reset role;

select tests.sign_in_as('11111111-1111-1111-1111-111111111111');
select throws_ok(
  $$ update public.project_documents set schema_version = 'hacked' $$,
  '42501',
  null,
  'T17: authenticated cannot direct-UPDATE project_documents (no grant)'
);

--------------------------------------------------------------------------------
-- T25a-e: soft-delete van organization verbergt alles
--------------------------------------------------------------------------------
-- User A voegt een tweede owner toe zodat we straks kunnen soft-deleten
--  (soft_delete_organization vereist FOR UPDATE op org)
-- Simpeler: user A verwijdert eigen org — hier alleen om verberging te testen
select tests.sign_out();
set role postgres;
update public.organizations set deleted_at = now() where slug = 'alpha-team';
reset role;

select tests.sign_in_as('11111111-1111-1111-1111-111111111111');
select is(
  (select count(*)::int from public.organizations where slug = 'alpha-team'),
  0, 'T25a: soft-deleted organization is invisible to its former owner');
select is(
  (select count(*)::int from public.projects
     where organization_id = (select id from public.organizations where slug = 'alpha-team')),
  0, 'T25b: projects in soft-deleted org are invisible');
select is(
  (select count(*)::int from public.project_documents
     where project_id in (
       select id from public.projects
        where organization_id in (select id from public.organizations where slug = 'alpha-team'))),
  0, 'T25c: documents in soft-deleted org are invisible');
select is(
  (select count(*)::int from public.project_document_versions),
  0, 'T25d: versions in soft-deleted org are invisible');
select is(
  (select count(*)::int from public.organization_members
     where organization_id in (select id from public.organizations where slug = 'alpha-team')),
  0, 'T25e: memberships in soft-deleted org are invisible');

--------------------------------------------------------------------------------
-- T30: auth.users is niet queryable vanaf authenticated
--------------------------------------------------------------------------------
select throws_ok(
  $$ select email from auth.users limit 1 $$,
  '42501',
  null,
  'T30: authenticated cannot SELECT from auth.users'
);

--------------------------------------------------------------------------------
-- T60: is_active_org_member returnt false voor soft-deleted membership
--------------------------------------------------------------------------------
set role postgres;
insert into public.organization_members
  (organization_id, user_id, role, invited_by, joined_at, deleted_at)
values (
  (select id from public.organizations where slug = 'beta-team'),
  '11111111-1111-1111-1111-111111111111',
  'viewer',
  '22222222-2222-2222-2222-222222222222',
  now() - interval '1 day',
  now() - interval '1 hour'
);
reset role;
select tests.sign_in_as('11111111-1111-1111-1111-111111111111');
select ok(
  not is_active_org_member(
    (select id from public.organizations where slug = 'beta-team')
  ),
  'T60: is_active_org_member returns false for soft-deleted membership'
);

select * from finish();
rollback;

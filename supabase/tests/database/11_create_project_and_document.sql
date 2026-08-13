-- 11_create_project_and_document.sql
-- pgTAP-tests voor create_project_and_document_internal (0011).
--
-- Dekt: (a) authz — alleen service_role mag deze RPC direct aanroepen,
-- (b) input-validatie inclusief null-actor-invariant, (c) org-/member-checks,
-- (d) happy-path met de exacte return-shape (project_id, project_document_id,
-- lock_version), (e) idempotency — een tweede call in dezelfde org retourneert
-- exact het bestaande project + doc zonder nieuwe rijen, (f) idempotency-
-- gedrag na een save die lock_version heeft opgehoogd — bootstrap retourneert
-- dan die opgehoogde lock_version (dus GEEN reset naar 1), (g) defense-in-
-- depth: een seed_doc dat jsonb-object is maar chk_doc_shape schendt raise't
-- 23514 (moet NIET in de Edge-Function-allowlist zitten zodat het als 500
-- naar de client komt — geen leak van shape-details).

begin;
set local search_path = extensions, public;

select plan(19);

--------------------------------------------------------------------------------
-- Setup: 4 users, 2 orgs
--   owner    → owner van bootstrap-team
--   editor   → editor van bootstrap-team
--   viewer   → viewer van bootstrap-team
--   outsider → owner van andere-team; geen member van bootstrap-team
--------------------------------------------------------------------------------
insert into auth.users (id, instance_id, email, encrypted_password,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role, email_confirmed_at, created_at, updated_at)
values
  ('aaaaaaaa-0011-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'owner@bs.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('bbbbbbbb-0011-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'editor@bs.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('cccccccc-0011-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'viewer@bs.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('dddddddd-0011-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000',
   'outsider@bs.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now());

select tests.sign_in_as('aaaaaaaa-0011-0000-0000-000000000001');
select create_organization('Bootstrap Team', 'bs-team');

select tests.sign_in_as('dddddddd-0011-0000-0000-000000000004');
select create_organization('Other Team', 'bs-other-team');

-- editor + viewer handmatig toevoegen aan bs-team
set role postgres;
insert into public.organization_members (organization_id, user_id, role, invited_by, joined_at)
values
  ((select id from public.organizations where slug = 'bs-team'),
   'bbbbbbbb-0011-0000-0000-000000000002', 'editor',
   'aaaaaaaa-0011-0000-0000-000000000001', now()),
  ((select id from public.organizations where slug = 'bs-team'),
   'cccccccc-0011-0000-0000-000000000003', 'viewer',
   'aaaaaaaa-0011-0000-0000-000000000001', now());
reset role;

-- Valide seed-doc voor herhaald gebruik.
-- Dezelfde minimum-shape als project_documents.chk_doc_shape verlangt.
create temp table _fixtures (
  valid_seed jsonb,
  bad_shape_seed jsonb
) on commit drop;
insert into _fixtures values (
  jsonb_build_object(
    'version', '0.1.0',
    'project', jsonb_build_object('documentType','website','title','Starter'),
    'pages',   jsonb_build_array(
                 jsonb_build_object('id','p1','root',
                   jsonb_build_object('id','r','type','layout-column','props','{}'::jsonb)))
  ),
  -- jsonb-object maar zonder 'pages' — passes jsonb_typeof-check in RPC,
  -- faalt op chk_doc_shape bij INSERT (verwacht 23514).
  jsonb_build_object(
    'version', '0.1.0',
    'project', jsonb_build_object('documentType','website','title','Broken'))
);

--------------------------------------------------------------------------------
-- authz: authenticated kan create_project_and_document_internal NIET direct
--------------------------------------------------------------------------------
select tests.sign_in_as('aaaaaaaa-0011-0000-0000-000000000001');
select throws_ok(
  format($fmt$
    select create_project_and_document_internal(
      %L::uuid,
      (select id from public.organizations where slug = 'bs-team'),
      'Starter Project', 'website',
      (select valid_seed from _fixtures),
      '0.1.0')
  $fmt$, 'aaaaaaaa-0011-0000-0000-000000000001'),
  '42501',
  null,
  'authenticated cannot call create_project_and_document_internal directly'
);

--------------------------------------------------------------------------------
-- authz: anon kan het ook niet
--------------------------------------------------------------------------------
select tests.sign_out();
set role anon;
select throws_ok(
  $$ select create_project_and_document_internal(
       '00000000-0000-0000-0000-000000000000'::uuid,
       '00000000-0000-0000-0000-000000000000'::uuid,
       'x', 'website', '{}'::jsonb, '0.1.0') $$,
  '42501',
  null,
  'anon cannot call create_project_and_document_internal directly'
);
reset role;

--------------------------------------------------------------------------------
-- service_role: NULL actor → missing_actor_user_id (28000)
--------------------------------------------------------------------------------
set role service_role;
select throws_ok(
  format($fmt$
    select create_project_and_document_internal(
      null::uuid,
      (select id from public.organizations where slug = 'bs-team'),
      'Starter Project', 'website',
      (select valid_seed from _fixtures),
      '0.1.0')
  $fmt$),
  '28000',
  null,
  'service_role with null actor raises missing_actor_user_id'
);
reset role;

--------------------------------------------------------------------------------
-- service_role: invalid_document_type
--------------------------------------------------------------------------------
set role service_role;
select throws_ok(
  format($fmt$
    select create_project_and_document_internal(
      %L::uuid,
      (select id from public.organizations where slug = 'bs-team'),
      'Starter Project', 'not-a-real-type',
      (select valid_seed from _fixtures),
      '0.1.0')
  $fmt$, 'aaaaaaaa-0011-0000-0000-000000000001'),
  '22023',
  null,
  'invalid p_document_type raises invalid_document_type (22023)'
);
reset role;

--------------------------------------------------------------------------------
-- service_role: invalid_name (leeg na trim)
--------------------------------------------------------------------------------
set role service_role;
select throws_ok(
  format($fmt$
    select create_project_and_document_internal(
      %L::uuid,
      (select id from public.organizations where slug = 'bs-team'),
      '   ', 'website',
      (select valid_seed from _fixtures),
      '0.1.0')
  $fmt$, 'aaaaaaaa-0011-0000-0000-000000000001'),
  '22023',
  null,
  'whitespace-only p_name raises invalid_name (22023)'
);
reset role;

--------------------------------------------------------------------------------
-- service_role: invalid_schema_version
--------------------------------------------------------------------------------
set role service_role;
select throws_ok(
  format($fmt$
    select create_project_and_document_internal(
      %L::uuid,
      (select id from public.organizations where slug = 'bs-team'),
      'Starter Project', 'website',
      (select valid_seed from _fixtures),
      '')
  $fmt$, 'aaaaaaaa-0011-0000-0000-000000000001'),
  '22023',
  null,
  'empty p_schema_version raises invalid_schema_version (22023)'
);
reset role;

--------------------------------------------------------------------------------
-- service_role: invalid_seed_doc (null)
--------------------------------------------------------------------------------
set role service_role;
select throws_ok(
  format($fmt$
    select create_project_and_document_internal(
      %L::uuid,
      (select id from public.organizations where slug = 'bs-team'),
      'Starter Project', 'website',
      null::jsonb,
      '0.1.0')
  $fmt$, 'aaaaaaaa-0011-0000-0000-000000000001'),
  '22023',
  null,
  'null p_seed_doc raises invalid_seed_doc (22023)'
);
reset role;

--------------------------------------------------------------------------------
-- service_role: invalid_seed_doc (jsonb-array, geen object)
--------------------------------------------------------------------------------
set role service_role;
select throws_ok(
  format($fmt$
    select create_project_and_document_internal(
      %L::uuid,
      (select id from public.organizations where slug = 'bs-team'),
      'Starter Project', 'website',
      '[]'::jsonb,
      '0.1.0')
  $fmt$, 'aaaaaaaa-0011-0000-0000-000000000001'),
  '22023',
  null,
  'array-shaped p_seed_doc raises invalid_seed_doc (22023)'
);
reset role;

--------------------------------------------------------------------------------
-- service_role: inactive org → organization_not_active (22023)
--------------------------------------------------------------------------------
-- Soft-delete de andere org, dan proberen te bootstrappen.
set role postgres;
update public.organizations
  set deleted_at = now()
  where slug = 'bs-other-team';
reset role;

set role service_role;
select throws_ok(
  format($fmt$
    select create_project_and_document_internal(
      %L::uuid,
      (select id from public.organizations where slug = 'bs-other-team'),
      'Starter Project', 'website',
      (select valid_seed from _fixtures),
      '0.1.0')
  $fmt$, 'dddddddd-0011-0000-0000-000000000004'),
  '22023',
  null,
  'soft-deleted org raises organization_not_active (22023)'
);
reset role;

--------------------------------------------------------------------------------
-- service_role: outsider (geen member) → membership_not_active (42501)
--------------------------------------------------------------------------------
set role service_role;
select throws_ok(
  format($fmt$
    select create_project_and_document_internal(
      %L::uuid,
      (select id from public.organizations where slug = 'bs-team'),
      'Starter Project', 'website',
      (select valid_seed from _fixtures),
      '0.1.0')
  $fmt$, 'dddddddd-0011-0000-0000-000000000004'),
  '42501',
  null,
  'non-member actor raises membership_not_active (42501)'
);
reset role;

--------------------------------------------------------------------------------
-- service_role: viewer role → insufficient_role (42501)
--------------------------------------------------------------------------------
set role service_role;
select throws_ok(
  format($fmt$
    select create_project_and_document_internal(
      %L::uuid,
      (select id from public.organizations where slug = 'bs-team'),
      'Starter Project', 'website',
      (select valid_seed from _fixtures),
      '0.1.0')
  $fmt$, 'cccccccc-0011-0000-0000-000000000003'),
  '42501',
  null,
  'viewer role raises insufficient_role (42501)'
);
reset role;

--------------------------------------------------------------------------------
-- service_role: happy path (geen bestaand project) → creates + returns
--------------------------------------------------------------------------------
set role service_role;
select lives_ok(
  format($fmt$
    select create_project_and_document_internal(
      %L::uuid,
      (select id from public.organizations where slug = 'bs-team'),
      'Starter Project', 'website',
      (select valid_seed from _fixtures),
      '0.1.0')
  $fmt$, 'aaaaaaaa-0011-0000-0000-000000000001'),
  'first bootstrap-call for org succeeds'
);

-- Verifieer dat er nu precies één actief project + één doc bestaat in de org.
select is(
  (select count(*)::integer from public.projects p
    where p.organization_id = (select id from public.organizations where slug = 'bs-team')
      and p.deleted_at is null),
  1,
  'exactly one active project exists after first bootstrap'
);
select is(
  (select d.lock_version from public.project_documents d
    join public.projects p on p.id = d.project_id
    where p.organization_id = (select id from public.organizations where slug = 'bs-team')
      and p.deleted_at is null),
  1,
  'newly created doc has lock_version = 1'
);
reset role;

--------------------------------------------------------------------------------
-- service_role: idempotent second call → EXACT same project_id + doc_id
--   Snapshot ids voor exacte match; tweede call moet identiek tupel geven.
--------------------------------------------------------------------------------
set role service_role;
select is(
  (select project_id from create_project_and_document_internal(
      'aaaaaaaa-0011-0000-0000-000000000001'::uuid,
      (select id from public.organizations where slug = 'bs-team'),
      'Would Be New Name', 'offerte',
      (select valid_seed from _fixtures),
      '0.1.0')),
  (select p.id from public.projects p
    where p.organization_id = (select id from public.organizations where slug = 'bs-team')
      and p.deleted_at is null
    order by p.created_at asc limit 1),
  'second bootstrap-call returns existing project_id (idempotent)'
);
select is(
  (select project_document_id from create_project_and_document_internal(
      'aaaaaaaa-0011-0000-0000-000000000001'::uuid,
      (select id from public.organizations where slug = 'bs-team'),
      'Would Be New Name', 'offerte',
      (select valid_seed from _fixtures),
      '0.1.0')),
  (select d.id from public.project_documents d
    join public.projects p on p.id = d.project_id
    where p.organization_id = (select id from public.organizations where slug = 'bs-team')
      and p.deleted_at is null
    order by p.created_at asc limit 1),
  'second bootstrap-call returns existing project_document_id (idempotent)'
);

-- Bevestig ook: no nieuwe projects/docs zijn aangemaakt door de idempotent calls.
select is(
  (select count(*)::integer from public.projects p
    where p.organization_id = (select id from public.organizations where slug = 'bs-team')),
  1,
  'idempotent calls did not insert extra projects'
);
select is(
  (select count(*)::integer from public.project_documents d
    join public.projects p on p.id = d.project_id
    where p.organization_id = (select id from public.organizations where slug = 'bs-team')),
  1,
  'idempotent calls did not insert extra project_documents'
);
reset role;

--------------------------------------------------------------------------------
-- Bump lock_version via save_document_internal en verifieer dat bootstrap
-- daarna dat opgehoogde lock_version teruggeeft (dus GEEN reset naar 1).
--------------------------------------------------------------------------------
set role service_role;
select save_document_internal(
  'aaaaaaaa-0011-0000-0000-000000000001'::uuid,
  (select p.id from public.projects p
    where p.organization_id = (select id from public.organizations where slug = 'bs-team')
      and p.deleted_at is null
    order by p.created_at asc limit 1),
  (select valid_seed from _fixtures),
  '0.1.0',
  1
);
select is(
  (select lock_version from create_project_and_document_internal(
      'aaaaaaaa-0011-0000-0000-000000000001'::uuid,
      (select id from public.organizations where slug = 'bs-team'),
      'ignored', 'website',
      (select valid_seed from _fixtures),
      '0.1.0')),
  2,
  'idempotent call after save returns the current bumped lock_version (not reset to 1)'
);
reset role;

--------------------------------------------------------------------------------
-- Defense-in-depth: seed_doc dat jsonb-object is maar chk_doc_shape schendt.
-- Moet 23514 raise'n (NIET in Edge-Function-allowlist → client krijgt 500).
-- Alleen relevant op het CREATE-pad. We hebben nu al een project in bs-team
-- (idempotency return't dat), dus test op een verse org: outsider heeft
-- 'bs-other-team' die we soft-deleteten — re-activeer die tijdelijk.
--
-- Simpelere aanpak: nieuwe user + nieuwe org waarin nog nooit een project is.
--------------------------------------------------------------------------------
insert into auth.users (id, instance_id, email, encrypted_password,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role, email_confirmed_at, created_at, updated_at)
values ('eeeeeeee-0011-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000',
        'freshowner@bs.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now());

select tests.sign_in_as('eeeeeeee-0011-0000-0000-000000000005');
select create_organization('Fresh Bootstrap Org', 'bs-fresh');

set role service_role;
select throws_ok(
  format($fmt$
    select create_project_and_document_internal(
      %L::uuid,
      (select id from public.organizations where slug = 'bs-fresh'),
      'Starter Project', 'website',
      (select bad_shape_seed from _fixtures),
      '0.1.0')
  $fmt$, 'eeeeeeee-0011-0000-0000-000000000005'),
  '23514',
  null,
  'malformed seed_doc (missing pages) hits chk_doc_shape → check_violation (23514)'
);
reset role;

select * from finish();
rollback;

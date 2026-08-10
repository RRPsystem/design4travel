-- 09_external_org_ref.sql
-- set_external_org_ref: alleen owner van actieve org mag; wijzigen én null zetten
-- werkt; buiten-org faalt; soft-deleted org faalt; admin/editor faalt.

begin;
set local search_path = extensions, public;

select plan(7);

insert into auth.users (id, instance_id, email, encrypted_password,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role, email_confirmed_at, created_at, updated_at)
values
  ('c9000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'owner@ext9.local','','{}'::jsonb,'{}'::jsonb,'authenticated','authenticated', now(), now(), now()),
  ('c9000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'admin@ext9.local','','{}'::jsonb,'{}'::jsonb,'authenticated','authenticated', now(), now(), now()),
  ('c9000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'outsider@ext9.local','','{}'::jsonb,'{}'::jsonb,'authenticated','authenticated', now(), now(), now());

select tests.sign_in_as('c9000000-0000-0000-0000-000000000001');
select create_organization('Ext Team', 'ext-team');

-- admin toevoegen
set role postgres;
insert into public.organization_members (organization_id, user_id, role, invited_by, joined_at)
values (
  (select id from public.organizations where slug = 'ext-team'),
  'c9000000-0000-0000-0000-000000000002', 'admin',
  'c9000000-0000-0000-0000-000000000001', now()
);
reset role;

--------------------------------------------------------------------------------
-- Ext-1: owner mag set (initial waarde)
--------------------------------------------------------------------------------
select tests.sign_in_as('c9000000-0000-0000-0000-000000000001');
select lives_ok(
  format($fmt$ select set_external_org_ref(%L::uuid, 'ref-v1') $fmt$,
    (select id from public.organizations where slug = 'ext-team')),
  'Ext-1a: owner mag external_org_ref zetten'
);
-- Controleer via postgres (kolom is niet in column-grant; RLS SELECT werkt wel)
select is(
  (select external_org_ref from public.organizations where slug = 'ext-team'),
  'ref-v1',
  'Ext-1b: waarde is gepersisteerd als ref-v1'
);

--------------------------------------------------------------------------------
-- Ext-2: owner mag wijzigen
--------------------------------------------------------------------------------
select lives_ok(
  format($fmt$ select set_external_org_ref(%L::uuid, 'ref-v2') $fmt$,
    (select id from public.organizations where slug = 'ext-team')),
  'Ext-2a: owner mag external_org_ref wijzigen'
);

--------------------------------------------------------------------------------
-- Ext-3: owner mag null zetten
--------------------------------------------------------------------------------
select lives_ok(
  format($fmt$ select set_external_org_ref(%L::uuid, null) $fmt$,
    (select id from public.organizations where slug = 'ext-team')),
  'Ext-3: owner mag external_org_ref op null zetten'
);

--------------------------------------------------------------------------------
-- Ext-4: admin mag NIET (only_owner)
--------------------------------------------------------------------------------
select tests.sign_in_as('c9000000-0000-0000-0000-000000000002');
select throws_ok(
  format($fmt$ select set_external_org_ref(%L::uuid, 'ref-admin') $fmt$,
    (select id from public.organizations where slug = 'ext-team')),
  '42501',
  null,
  'Ext-4: admin krijgt only_owner'
);

--------------------------------------------------------------------------------
-- Ext-5: outsider (geen lid) → only_owner (of organization_not_active)
--------------------------------------------------------------------------------
-- Outsider ziet de org niet via RLS, dus we cachen de id BEFORE we switchen
-- (anders krijgt outsider een NULL uit de subquery en raise de RPC eerst
-- 'organization_not_active' i.p.v. 'only_owner').
select set_config('test.ext_org_id',
  (select id::text from public.organizations where slug = 'ext-team'),
  false);
select tests.sign_in_as('c9000000-0000-0000-0000-000000000003');
select throws_ok(
  format($fmt$ select set_external_org_ref(%L::uuid, 'ref-x') $fmt$,
    current_setting('test.ext_org_id')::uuid),
  '42501',
  null,
  'Ext-5: outsider krijgt only_owner'
);

--------------------------------------------------------------------------------
-- Ext-6: soft-deleted organization → organization_not_active
--------------------------------------------------------------------------------
set role postgres;
update public.organizations set deleted_at = now() where slug = 'ext-team';
reset role;

select tests.sign_in_as('c9000000-0000-0000-0000-000000000001');
select throws_ok(
  format($fmt$ select set_external_org_ref(%L::uuid, 'ref-y') $fmt$,
    (select id from public.organizations where slug = 'ext-team')),
  '22023',
  null,
  'Ext-6: soft-deleted org → organization_not_active (owner blocked)'
);

select * from finish();
rollback;

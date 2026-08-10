-- 04_projects_and_invitations.sql
-- T3, T5, T6, T10 (replaced by T5b), T19, T28, T29, T50, T56, T57 slice

begin;
set local search_path = extensions, public;

select plan(10);

-- Setup — alle auth.users worden VOORAF aangemaakt (auth.users is niet
-- INSERT-baar door authenticated, dus na sign_in_as werkt insert niet meer)
insert into auth.users (id, instance_id, email, encrypted_password,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role, email_confirmed_at, created_at, updated_at)
values
  ('aa111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
   'a@pj.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('bb222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
   'b@pj.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('dd333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000',
   'd@pj.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now());

select tests.sign_in_as('aa111111-1111-1111-1111-111111111111');
select create_organization('PJ Team', 'pj-team');

-- b als viewer toevoegen (via directe insert, sneller dan invite-flow)
set role postgres;
insert into public.organization_members (organization_id, user_id, role, invited_by, joined_at)
values (
  (select id from public.organizations where slug = 'pj-team'),
  'bb222222-2222-2222-2222-222222222222', 'viewer',
  'aa111111-1111-1111-1111-111111111111', now()
);
reset role;

--------------------------------------------------------------------------------
-- T3: viewer kan geen project aanmaken
--------------------------------------------------------------------------------
select tests.sign_in_as('bb222222-2222-2222-2222-222222222222');
select throws_ok(
  format($fmt$ select create_project(%L::uuid, 'Viewer project', 'website', null) $fmt$,
    (select id from public.organizations where slug = 'pj-team')),
  '42501',
  null,
  'T3: viewer cannot create project (insufficient_role)'
);

--------------------------------------------------------------------------------
-- T6: editor mag eigen project soft-deleten
--------------------------------------------------------------------------------
-- b promoveren naar editor
set role postgres;
update public.organization_members
  set role = 'editor'
  where user_id = 'bb222222-2222-2222-2222-222222222222' and deleted_at is null;
reset role;

select tests.sign_in_as('bb222222-2222-2222-2222-222222222222');
select create_project(
  (select id from public.organizations where slug = 'pj-team'),
  'B eigen project', 'offerte', null
);
select lives_ok(
  format($fmt$ select soft_delete_project(%L::uuid) $fmt$,
    (select id from public.projects where name = 'B eigen project')),
  'T6: editor can soft-delete own project'
);

--------------------------------------------------------------------------------
-- T5: editor mag niet andermans project soft-deleten
--------------------------------------------------------------------------------
select tests.sign_in_as('aa111111-1111-1111-1111-111111111111');
select create_project(
  (select id from public.organizations where slug = 'pj-team'),
  'A eigen project', 'website', null
);
select tests.sign_in_as('bb222222-2222-2222-2222-222222222222');
select throws_ok(
  format($fmt$ select soft_delete_project(%L::uuid) $fmt$,
    (select id from public.projects where name = 'A eigen project')),
  '42501',
  null,
  'T5: editor cannot soft-delete another user''s project'
);

--------------------------------------------------------------------------------
-- T19: create_project in vreemde org faalt
--------------------------------------------------------------------------------
-- Voeg tweede org toe zonder user_b als lid
select tests.sign_in_as('aa111111-1111-1111-1111-111111111111');
select create_organization('Solo Team', 'solo-team');

-- Vang solo-team id via session-config (temp tables botsen op cross-role toegang)
select set_config('test.solo_id',
  (select id::text from public.organizations where slug = 'solo-team'),
  false);

select tests.sign_in_as('bb222222-2222-2222-2222-222222222222');
select throws_ok(
  format($fmt$ select create_project(%L::uuid, 'x', 'website', null) $fmt$,
    current_setting('test.solo_id')),
  '42501',
  null,
  'T19: create_project in foreign org fails with insufficient_role'
);

--------------------------------------------------------------------------------
-- T5b: owner-invite wordt geweigerd
--------------------------------------------------------------------------------
select tests.sign_in_as('aa111111-1111-1111-1111-111111111111');
select throws_ok(
  format($fmt$ select invite_member(%L::uuid, 'x@x.com', 'owner') $fmt$,
    (select id from public.organizations where slug = 'pj-team')),
  '22023',
  null,
  'T5b: invite_member rejects role=owner (Option A)'
);

--------------------------------------------------------------------------------
-- T28: accept_invitation met verkeerde e-mail faalt
--------------------------------------------------------------------------------
-- Stuur invite naar d's e-mail (d bestaat al uit setup)
select tests.sign_in_as('aa111111-1111-1111-1111-111111111111');

-- Genereer invitation en pak het token
create temp table _tok as
  select invite_member(
    (select id from public.organizations where slug = 'pj-team'),
    'd@pj.local', 'editor'
  ) as token;

-- User b probeert d's invite te accepteren → email_mismatch
select tests.sign_in_as('bb222222-2222-2222-2222-222222222222');
select throws_ok(
  format($fmt$ select accept_invitation(%L) $fmt$, (select token from _tok)),
  '22023',
  null,
  'T28: accept_invitation with mismatched email fails'
);

--------------------------------------------------------------------------------
-- T50: DB bevat GEEN klartext-token, uitsluitend hash
--------------------------------------------------------------------------------
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organization_invitations'
      and column_name = 'token'
  ),
  'T50: organization_invitations has NO token column, only token_hash'
);
-- Kolom-grant sluit token_hash uit voor authenticated; check daarom als postgres.
select tests.sign_out();
set role postgres;
select is(
  (select pg_typeof(token_hash)::text from public.organization_invitations limit 1),
  'bytea',
  'T50: token_hash column is bytea'
);
reset role;
select tests.sign_in_as('bb222222-2222-2222-2222-222222222222');

--------------------------------------------------------------------------------
-- T29: verlopen invitation kan niet geaccepteerd worden
--------------------------------------------------------------------------------
set role postgres;
update public.organization_invitations set expires_at = now() - interval '1 day'
  where accepted_at is null;
reset role;

select tests.sign_in_as('dd333333-3333-3333-3333-333333333333');
select throws_ok(
  format($fmt$ select accept_invitation(%L) $fmt$, (select token from _tok)),
  '22023',
  null,
  'T29: expired invitation cannot be accepted'
);

--------------------------------------------------------------------------------
-- T56: create_organization gebruikt auth.uid(), niet body-parameter
--------------------------------------------------------------------------------
-- Signature van create_organization heeft geen p_created_by-parameter
select ok(
  not exists (
    select 1 from information_schema.parameters
    where specific_schema = 'public'
      and specific_name like 'create_organization%'
      and parameter_name = 'p_created_by'
  ),
  'T56: create_organization has no p_created_by parameter (identity via auth.uid())'
);

select * from finish();
rollback;

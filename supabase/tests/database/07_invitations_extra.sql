-- 07_invitations_extra.sql
-- Aanvullende invitation-tests: "mijn inbox"-flow, revoke-idempotency,
-- previous-membership-restore-branch.

begin;
select plan(12);

-- Setup: user_owner + user_invitee (nog geen lid) + user_other (uninvolved)
insert into auth.users (id, instance_id, email, encrypted_password,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role, email_confirmed_at, created_at, updated_at)
values
  ('a7000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'owner@inv7.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('a7000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'invitee@inv7.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('a7000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'other@inv7.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('a7000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000',
   'restore@inv7.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now());

select tests.sign_in_as('a7000000-0000-0000-0000-000000000001');
select create_organization('Inv7 Team', 'inv7-team');

-- Twee invitations aanmaken: één voor invitee, één voor other-email
select invite_member(
  (select id from public.organizations where slug = 'inv7-team'),
  'invitee@inv7.local', 'editor'
);
select invite_member(
  (select id from public.organizations where slug = 'inv7-team'),
  'someone-else@inv7.local', 'viewer'
);

--------------------------------------------------------------------------------
-- Inbox-1: invitee ziet exact zijn eigen inkomende invitation, niets anders
--------------------------------------------------------------------------------
select tests.sign_in_as('a7000000-0000-0000-0000-000000000002');

-- Geen 42501 — de query moet gewoon slagen (regressietest voor de blocker)
select lives_ok(
  $$ select count(*) from public.organization_invitations $$,
  'Inbox-1a: invitee (not org member) can query invitations without permission_denied'
);

select is(
  (select count(*)::int from public.organization_invitations
     where lower(email::text) = 'invitee@inv7.local'),
  1,
  'Inbox-1b: invitee ziet zijn eigen invitation (op JWT-email)'
);

select is(
  (select count(*)::int from public.organization_invitations
     where lower(email::text) <> 'invitee@inv7.local'),
  0,
  'Inbox-1c: invitee ziet GEEN invitations voor andere e-mails'
);

--------------------------------------------------------------------------------
-- Inbox-2: user_other met andere e-mail ziet géén van beide invitations
--------------------------------------------------------------------------------
select tests.sign_in_as('a7000000-0000-0000-0000-000000000003');
select is(
  (select count(*)::int from public.organization_invitations),
  0,
  'Inbox-2: user_other (geen match op email, geen lid) ziet 0 invitations'
);

--------------------------------------------------------------------------------
-- Revoke-1: owner kan een invitation revoken → status = revoked
--------------------------------------------------------------------------------
select tests.sign_in_as('a7000000-0000-0000-0000-000000000001');

-- Pak de invitation-id voor de eigen-uitnodiging via query (owner is lid → mag zien)
select set_config('test.inv_id',
  (select id::text from public.organization_invitations
     where lower(email::text) = 'someone-else@inv7.local'),
  false);

select lives_ok(
  format($fmt$ select revoke_invitation(%L::uuid) $fmt$,
    current_setting('test.inv_id')::uuid),
  'Revoke-1a: owner revokes invitation succesvol'
);
select is(
  (select revoked_at is not null from public.organization_invitations
     where id = current_setting('test.inv_id')::uuid),
  true,
  'Revoke-1b: revoked_at is gezet'
);

--------------------------------------------------------------------------------
-- Revoke-2 (idempotency): 2e revoke levert geen error op, laat revoked_at intact
--------------------------------------------------------------------------------
select set_config('test.revoked_at_before',
  (select revoked_at::text from public.organization_invitations
     where id = current_setting('test.inv_id')::uuid),
  false);

select lives_ok(
  format($fmt$ select revoke_invitation(%L::uuid) $fmt$,
    current_setting('test.inv_id')::uuid),
  'Revoke-2a: 2e revoke_invitation is idempotent (geen error)'
);
select is(
  (select revoked_at::text from public.organization_invitations
     where id = current_setting('test.inv_id')::uuid),
  current_setting('test.revoked_at_before'),
  'Revoke-2b: revoked_at is niet overschreven door 2e revoke'
);

--------------------------------------------------------------------------------
-- Revoke-3: onbevoegde gebruiker (viewer/vreemde) mag niet revoken
--------------------------------------------------------------------------------
-- user_other is geen lid → insufficient_role (of niet-vindbaar)
select tests.sign_in_as('a7000000-0000-0000-0000-000000000003');

-- Nieuwe invitation om te testen (niet de al-revoked)
select tests.sign_in_as('a7000000-0000-0000-0000-000000000001');
select invite_member(
  (select id from public.organizations where slug = 'inv7-team'),
  'yet-another@inv7.local', 'viewer'
);
select set_config('test.inv_id2',
  (select id::text from public.organization_invitations
     where lower(email::text) = 'yet-another@inv7.local'),
  false);

select tests.sign_in_as('a7000000-0000-0000-0000-000000000003');
select throws_ok(
  format($fmt$ select revoke_invitation(%L::uuid) $fmt$,
    current_setting('test.inv_id2')::uuid),
  '42501',
  null,
  'Revoke-3: outsider kan invitation niet revoken (insufficient_role)'
);

--------------------------------------------------------------------------------
-- Previous-membership: accept_invitation faalt met previous_membership_needs_manual_restore
-- als de user een soft-deleted membership heeft; geen stilzwijgende insert of restore.
--------------------------------------------------------------------------------

-- Zet user_restore als (soft-deleted) member in inv7-team
set role postgres;
insert into public.organization_members
  (organization_id, user_id, role, invited_by, joined_at, deleted_at)
values (
  (select id from public.organizations where slug = 'inv7-team'),
  'a7000000-0000-0000-0000-000000000004',
  'editor',
  'a7000000-0000-0000-0000-000000000001',
  now() - interval '1 day',
  now() - interval '1 hour'
);
reset role;

-- Owner stuurt fresh invite naar restore@inv7.local en bewaart klartext-token
select tests.sign_in_as('a7000000-0000-0000-0000-000000000001');
select set_config(
  'test.restore_token',
  invite_member(
    (select id from public.organizations where slug = 'inv7-team'),
    'restore@inv7.local', 'viewer'
  ),
  false
);

-- user_restore accepteert → moet falen (previous membership soft-deleted)
select tests.sign_in_as('a7000000-0000-0000-0000-000000000004');
select throws_ok(
  format($fmt$ select accept_invitation(%L) $fmt$, current_setting('test.restore_token')),
  '42501',
  null,
  'PrevMember-1: accept met soft-deleted previous membership raise previous_membership_needs_manual_restore'
);

-- Geen nieuwe insert; geen restore
select is(
  (select count(*)::int from public.organization_members
     where user_id = 'a7000000-0000-0000-0000-000000000004'
       and organization_id = (select id from public.organizations where slug = 'inv7-team')
       and deleted_at is null),
  0,
  'PrevMember-2: geen stilzwijgend nieuw of geheract membership'
);

-- Invitation blijft accepted_at is null (transactie van accept rolde terug)
set role postgres;
select is(
  (select count(*)::int from public.organization_invitations
     where lower(email::text) = 'restore@inv7.local'
       and accepted_at is null and revoked_at is null),
  1,
  'PrevMember-3: invitation blijft in pending-state'
);
reset role;

select * from finish();
rollback;

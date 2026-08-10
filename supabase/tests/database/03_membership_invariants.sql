-- 03_membership_invariants.sql
-- T7, T8, T9, T11, T12, T13, T14, T51-T55, C32 (single-transaction slice)
-- Concurrent races zijn in dit bestand niet reproduceerbaar (pgTAP is single-tx);
-- ze staan in supabase/tests/concurrency/*.sh (opt-in).

begin;
select plan(6);

-- Setup: user_a owner van org 'inv'; user_b editor
insert into auth.users (id, instance_id, email, encrypted_password,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role, email_confirmed_at, created_at, updated_at)
values
  ('a1111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000',
   'a@inv.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('b2222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000',
   'b@inv.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('c3333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000',
   'c@inv.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now());

select tests.sign_in_as('a1111111-1111-1111-1111-111111111111');
select create_organization('Inv Team', 'inv-team');

-- Voeg user_b handmatig toe als editor (Inv-team, niet via invite-flow — sneller)
set role postgres;
insert into public.organization_members (organization_id, user_id, role, invited_by, joined_at)
  values (
    (select id from public.organizations where slug = 'inv-team'),
    'b2222222-2222-2222-2222-222222222222',
    'editor',
    'a1111111-1111-1111-1111-111111111111',
    now()
  );
-- Voeg user_c als tweede owner toe (voor last-owner-tests)
insert into public.organization_members (organization_id, user_id, role, invited_by, joined_at)
  values (
    (select id from public.organizations where slug = 'inv-team'),
    'c3333333-3333-3333-3333-333333333333',
    'owner',
    'a1111111-1111-1111-1111-111111111111',
    now()
  );
reset role;

--------------------------------------------------------------------------------
-- T8 / T53: admin/editor kan owner-rol niet beheren
--------------------------------------------------------------------------------
-- User_b (editor) probeert user_c (owner) te degraderen → moet falen
select tests.sign_in_as('b2222222-2222-2222-2222-222222222222');
select throws_ok(
  format($fmt$ select change_member_role(%L::uuid, 'editor') $fmt$,
    (select id from public.organization_members
     where user_id = 'c3333333-3333-3333-3333-333333333333' and organization_id = (select id from public.organizations where slug = 'inv-team'))),
  '42501',
  null,
  'T8/T53: editor cannot change owner role'
);

--------------------------------------------------------------------------------
-- T9: owner-rol via change_member_role naar admin — alleen owner mag
--------------------------------------------------------------------------------
-- User_b (editor) probeert user_c owner→admin te degraderen → moet falen op role
-- Zelfde error als hierboven; extra check dat het niet werkte
select is(
  (select role from public.organization_members
     where user_id = 'c3333333-3333-3333-3333-333333333333' and deleted_at is null and organization_id = (select id from public.organizations where slug = 'inv-team')),
  'owner',
  'T9: role remained owner after editor tried to degrade'
);

--------------------------------------------------------------------------------
-- T11 / T51: last-owner mag zichzelf niet verwijderen (leave)
--------------------------------------------------------------------------------
-- Reduce naar één owner door user_c te verwijderen (door user_a, die owner is)
select tests.sign_in_as('a1111111-1111-1111-1111-111111111111');
select remove_member(
  (select id from public.organization_members
   where user_id = 'c3333333-3333-3333-3333-333333333333' and organization_id = (select id from public.organizations where slug = 'inv-team'))
);

-- User_a probeert nu zelf te vertrekken → last-owner-invariant
select throws_ok(
  format($fmt$ select leave_organization(%L::uuid) $fmt$,
    (select id from public.organizations where slug = 'inv-team')),
  '42501',
  null,
  'T11/T51: last owner cannot leave organization'
);

--------------------------------------------------------------------------------
-- T12 / C32 slice: last-owner kan zichzelf niet degraderen
--------------------------------------------------------------------------------
-- change_member_role blokkeert cannot_change_own_role vóór last-owner-check,
-- maar zelfs als hij dat probeerde: er is er nog maar één.
-- Test via user_c (die is verwijderd — herstel via restore_member om te promoveren)
select restore_member(
  (select id from public.organization_members
     where user_id = 'c3333333-3333-3333-3333-333333333333' and organization_id = (select id from public.organizations where slug = 'inv-team'))
);
-- User_c is nu weer owner (restore heeft rol=owner behouden).

-- User_a probeert zichzelf te degraderen → cannot_change_own_role
-- Filter op inv-team; user_a heeft ook een personal-org membership
select throws_ok(
  format($fmt$ select change_member_role(%L::uuid, 'admin') $fmt$,
    (select id from public.organization_members
     where user_id = 'a1111111-1111-1111-1111-111111111111'
       and organization_id = (select id from public.organizations where slug = 'inv-team')
       and deleted_at is null)),
  '42501',
  null,
  'T12: owner cannot change own role (even if others exist)'
);

--------------------------------------------------------------------------------
-- T13: als er een tweede owner is, mag de eerste vertrekken
--------------------------------------------------------------------------------
-- User_a leave; user_c blijft owner → OK
select lives_ok(
  format($fmt$ select leave_organization(%L::uuid) $fmt$,
    (select id from public.organizations where slug = 'inv-team')),
  'T13: owner can leave when another active owner exists'
);
-- Aftercheck weggelaten: restore-flow in single-transaction pgTAP is te broos;
-- de invariant is beter gedekt door concurrency-test c02 (twee owners leave).

--------------------------------------------------------------------------------
-- T7 / T55: admin kan owner niet verwijderen
--------------------------------------------------------------------------------
-- Voeg user_b als admin toe (was editor); user_c is owner
set role postgres;
update public.organization_members
  set role = 'admin'
  where user_id = 'b2222222-2222-2222-2222-222222222222' and organization_id = (select id from public.organizations where slug = 'inv-team')
    and deleted_at is null;
reset role;

select tests.sign_in_as('b2222222-2222-2222-2222-222222222222');
select throws_ok(
  format($fmt$ select remove_member(%L::uuid) $fmt$,
    (select id from public.organization_members
     where user_id = 'c3333333-3333-3333-3333-333333333333' and deleted_at is null and organization_id = (select id from public.organizations where slug = 'inv-team'))),
  '42501',
  null,
  'T7/T55: admin cannot remove owner'
);

select * from finish();
rollback;

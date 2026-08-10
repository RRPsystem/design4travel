-- 06_quotas.sql
-- Q1: membership-quota (max 5 actieve per user) bij create_organization
-- Q2: project-quota (max 20 actieve per org) bij create_project
-- Q3: invite-rate is per organisatie (30/uur), niet per user

begin;
set local search_path = extensions, public;

select plan(9);

-- Setup: één user
insert into auth.users (id, instance_id, email, encrypted_password,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role, email_confirmed_at, created_at, updated_at)
values ('50505050-5050-5050-5050-505050505050',
        '00000000-0000-0000-0000-000000000000',
        'quota@test.local','','{}'::jsonb,'{}'::jsonb,
        'authenticated','authenticated', now(), now(), now());
-- Auto-trigger heeft nu 1 personal-org aangemaakt → count = 1

select tests.sign_in_as('50505050-5050-5050-5050-505050505050');

--------------------------------------------------------------------------------
-- Q1: max 5 actieve memberships per user
--------------------------------------------------------------------------------
-- Personal (1) + create 4 → 5. Zesde faalt.
select lives_ok($$ select create_organization('Org 2', 'quota-2') $$, 'Q1: 2nd org OK');
select lives_ok($$ select create_organization('Org 3', 'quota-3') $$, 'Q1: 3rd org OK');
select lives_ok($$ select create_organization('Org 4', 'quota-4') $$, 'Q1: 4th org OK');
select lives_ok($$ select create_organization('Org 5', 'quota-5') $$, 'Q1: 5th org OK');
select throws_ok(
  $$ select create_organization('Org 6', 'quota-6') $$,
  '23514',
  null,
  'Q1: 6th org fails with membership_quota_exceeded'
);

--------------------------------------------------------------------------------
-- Q2: max 20 actieve projecten per organisatie
--------------------------------------------------------------------------------
-- In personal-org 20 projecten maken; 21e faalt
do $$
declare
  v_org uuid := (select id from public.organizations where slug like 'p-%' and created_by = '50505050-5050-5050-5050-505050505050');
  i int;
begin
  for i in 1..20 loop
    perform create_project(v_org, 'p'||i, 'website', null);
  end loop;
end $$;

select throws_ok(
  format($fmt$ select create_project(%L::uuid, 'nummer21', 'website', null) $fmt$,
    (select id from public.organizations where slug like 'p-%' and created_by = '50505050-5050-5050-5050-505050505050')),
  '23514',
  null,
  'Q2: 21st project fails with project_quota_exceeded'
);

--------------------------------------------------------------------------------
-- Q3: max 30 invitations per organization per uur
-- Rate-limit is per-org, dus twee orgs moeten onafhankelijk kunnen invitaten.
--------------------------------------------------------------------------------

-- User_r maakt een fresh org (los van personal-org quota-testinfra hierboven).
-- User_r's personal-org telt al = 1 membership; deze org = 2 (binnen Q1-limiet 5).
-- Sign_out + role postgres nodig omdat we nog als user_5050 draaien en
-- authenticated GEEN insert op auth.users heeft.
select tests.sign_out();
set role postgres;
insert into auth.users (id, instance_id, email, encrypted_password,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role, email_confirmed_at, created_at, updated_at)
values ('60606060-6060-6060-6060-606060606060',
        '00000000-0000-0000-0000-000000000000',
        'r@ratelimit.local','','{}'::jsonb,'{}'::jsonb,
        'authenticated','authenticated', now(), now(), now());
reset role;

select tests.sign_in_as('60606060-6060-6060-6060-606060606060');
select create_organization('Rate Org', 'rate-org');
select create_organization('Rate Two', 'rate-two');

-- Verzend 30 invitations naar unieke e-mails in rate-org → allemaal OK
do $$
declare
  v_org uuid := (select id from public.organizations where slug = 'rate-org');
  i int;
begin
  for i in 1..30 loop
    perform invite_member(v_org, 'invite'||i||'@ratelimit.local', 'editor');
  end loop;
end $$;

-- rate_limit_counters heeft géén client-grants (alleen RPC-writes) — check als postgres
select tests.sign_out();
set role postgres;
select is(
  (select count::int from public.rate_limit_counters
   where scope_id = (select id from public.organizations where slug = 'rate-org')
     and action = 'invite_member'
     and window_start = date_trunc('hour', now())),
  30,
  'Q3a: rate_limit_counters shows 30 invites voor rate-org in dit uur'
);
reset role;
select tests.sign_in_as('60606060-6060-6060-6060-606060606060');

-- 31e invite → moet falen met rate_limit_exceeded
select throws_ok(
  format($fmt$ select invite_member(%L::uuid, 'invite31@ratelimit.local', 'editor') $fmt$,
    (select id from public.organizations where slug = 'rate-org')),
  '53400',
  null,
  'Q3b: 31st invite fails with rate_limit_exceeded'
);

-- Isolatie tussen orgs: rate-two zit nog op 0/30 → één invite moet slagen
select lives_ok(
  format($fmt$ select invite_member(%L::uuid, 'first@ratelimit.local', 'editor') $fmt$,
    (select id from public.organizations where slug = 'rate-two')),
  'Q3c: rate-two org has independent rate-limit window (invite OK)'
);

select * from finish();
rollback;

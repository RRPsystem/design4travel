-- 08_profiles_visibility.sql
-- p_profiles_self_or_shared_read: user ziet eigen profiel + profielen van
-- andere actieve leden in gedeelde actieve organisaties. Verder niets.

begin;
select plan(6);

-- Setup: 4 users, 2 orgs
--   share-a: user1(owner), user2(editor)
--   share-b: user3(owner)
--   user4: totaal geen orgs (behalve eigen personal)
insert into auth.users (id, instance_id, email, encrypted_password,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role, email_confirmed_at, created_at, updated_at)
values
  ('b8000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'u1@prof8.local','','{}'::jsonb,'{}'::jsonb,'authenticated','authenticated', now(), now(), now()),
  ('b8000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'u2@prof8.local','','{}'::jsonb,'{}'::jsonb,'authenticated','authenticated', now(), now(), now()),
  ('b8000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'u3@prof8.local','','{}'::jsonb,'{}'::jsonb,'authenticated','authenticated', now(), now(), now()),
  ('b8000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000',
   'u4@prof8.local','','{}'::jsonb,'{}'::jsonb,'authenticated','authenticated', now(), now(), now());

select tests.sign_in_as('b8000000-0000-0000-0000-000000000001');
select create_organization('Share A', 'share-a');

select tests.sign_in_as('b8000000-0000-0000-0000-000000000003');
select create_organization('Share B', 'share-b');

-- user2 aan share-a toevoegen (via directe insert, sneller)
set role postgres;
insert into public.organization_members (organization_id, user_id, role, invited_by, joined_at)
values (
  (select id from public.organizations where slug = 'share-a'),
  'b8000000-0000-0000-0000-000000000002', 'editor',
  'b8000000-0000-0000-0000-000000000001', now()
);
reset role;

--------------------------------------------------------------------------------
-- Prof-1: eigen profiel is altijd zichtbaar
--------------------------------------------------------------------------------
select tests.sign_in_as('b8000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.profiles where id = 'b8000000-0000-0000-0000-000000000001'),
  1,
  'Prof-1: user1 ziet eigen profiel'
);

--------------------------------------------------------------------------------
-- Prof-2: profiel van actief medelid in gedeelde actieve organization
--------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.profiles where id = 'b8000000-0000-0000-0000-000000000002'),
  1,
  'Prof-2: user1 ziet user2 (medelid in share-a)'
);

--------------------------------------------------------------------------------
-- Prof-3: geen profiel van user in andere org
--------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.profiles where id = 'b8000000-0000-0000-0000-000000000003'),
  0,
  'Prof-3: user1 ziet user3 NIET (andere org)'
);

--------------------------------------------------------------------------------
-- Prof-4: geen profiel van compleet losstaande user
--------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.profiles where id = 'b8000000-0000-0000-0000-000000000004'),
  0,
  'Prof-4: user1 ziet user4 NIET (geen gedeelde org)'
);

--------------------------------------------------------------------------------
-- Prof-5: soft-deleted membership verbergt profiel-zichtbaarheid via die org
--------------------------------------------------------------------------------
-- Soft-delete user2's membership in share-a → user1 mag user2 niet meer zien
set role postgres;
update public.organization_members
  set deleted_at = now()
  where user_id = 'b8000000-0000-0000-0000-000000000002'
    and organization_id = (select id from public.organizations where slug = 'share-a');
reset role;

select tests.sign_in_as('b8000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.profiles where id = 'b8000000-0000-0000-0000-000000000002'),
  0,
  'Prof-5: soft-deleted membership verbergt medelid uit share-a'
);

--------------------------------------------------------------------------------
-- Prof-6: soft-deleted organization verbergt alles (herstel eerst user2 in share-a)
--------------------------------------------------------------------------------
set role postgres;
update public.organization_members
  set deleted_at = null
  where user_id = 'b8000000-0000-0000-0000-000000000002'
    and organization_id = (select id from public.organizations where slug = 'share-a');
update public.organizations set deleted_at = now() where slug = 'share-a';
reset role;

select tests.sign_in_as('b8000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.profiles where id = 'b8000000-0000-0000-0000-000000000002'),
  0,
  'Prof-6: soft-deleted organization verbergt medelid'
);

select * from finish();
rollback;

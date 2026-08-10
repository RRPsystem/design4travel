-- Gedeelde seed voor concurrency-scripts.
-- Wordt vóór elk script opnieuw geladen. Elk script begint met een cascade-
-- truncate van alle public.-tabellen zodat er geen residu is uit vorige runs
-- (organizations.created_by is RESTRICT, dus een simpel `delete from auth.users`
-- volstaat niet als er nog orgs of memberships aan de user hangen).

begin;

-- Wipe alle publieke test-data
truncate
  public.rate_limit_counters,
  public.document_data_snapshots,
  public.project_document_versions,
  public.project_documents,
  public.projects,
  public.organization_invitations,
  public.organization_members,
  public.organizations,
  public.profiles
cascade;

-- Nu kunnen de test-users veilig verwijderd worden (cascades op profiles zijn
-- opgeruimd door de truncate hierboven).
delete from auth.users where email in ('o1@race.local','o2@race.local','ex@race.local','invitee@race.local');

insert into auth.users (id, instance_id, email, encrypted_password,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role, email_confirmed_at, created_at, updated_at)
values
  ('11111111-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'o1@race.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated',
   now(), now(), now()),
  ('22222222-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'o2@race.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated',
   now(), now(), now()),
  ('33333333-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'ex@race.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated',
   now(), now(), now());

-- Org via de RPC, dan tweede owner handmatig toevoegen
select set_config('request.jwt.claims',
  '{"sub":"11111111-0000-0000-0000-000000000001","role":"authenticated"}', false);
select set_config('role', 'authenticated', false);
select public.create_organization('Race Team', 'race-team');

set role postgres;
insert into public.organization_members (organization_id, user_id, role, invited_by, joined_at)
values
  ((select id from public.organizations where slug = 'race-team'),
   '22222222-0000-0000-0000-000000000002', 'owner',
   '11111111-0000-0000-0000-000000000001', now()),
  ((select id from public.organizations where slug = 'race-team'),
   '33333333-0000-0000-0000-000000000003', 'editor',
   '11111111-0000-0000-0000-000000000001', now());
reset role;

commit;

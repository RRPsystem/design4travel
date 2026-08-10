-- supabase/seed.sql
-- Draait automatisch na alle migrations bij `supabase db reset` (lokaal).
-- Wordt NIET automatisch op remote/productie geladen.
--
-- Doel: test-infrastructuur (schema `tests` + `tests.sign_in_as`) beschikbaar
-- maken voor pgTAP-runs. Deze helper simuleert een ingelogde eindgebruiker door
-- de request.jwt.claims-GUC te zetten en role te schakelen naar authenticated.
--
-- Bewust GEEN grant naar authenticated/anon/public — alleen postgres/service_role
-- kunnen deze functie aanroepen, waardoor een echte user hem niet kan misbruiken
-- om `auth.uid()` te vervalsen.

create schema if not exists tests;

-- Opgesplitst: SECURITY DEFINER-helper voor auth.users-lookup, en een
-- reguliere sign_in_as die de role-switch doet als caller. `set_config('role',
-- ...)` mag NIET binnen een SECURITY DEFINER-functie draaien (Postgres verbiedt
-- dat expliciet), dus deze scheiding is noodzakelijk.
create or replace function tests._email_for(p_user_id uuid)
returns text
language sql
security definer
set search_path = pg_catalog, public
as $$
  select email from auth.users where id = p_user_id;
$$;
alter function tests._email_for(uuid) owner to postgres;

create or replace function tests.sign_in_as(p_user_id uuid)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_email text;
begin
  v_email := tests._email_for(p_user_id);
  perform set_config(
    'request.jwt.claims',
    json_build_object(
      'sub',   p_user_id::text,
      'role',  'authenticated',
      'email', v_email
    )::text,
    true
  );
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function tests.sign_out()
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  perform set_config('request.jwt.claims', null, true);
  perform set_config('role', 'postgres', true);
end $$;

-- Grants voor test-runners:
-- pgTAP-testfiles beginnen als postgres, callen sign_in_as → switch naar
-- authenticated, en willen daarna opnieuw sign_in_as callen om van user te
-- wisselen. Daarvoor moet `authenticated` USAGE op de tests-schema hebben.
-- Deze grants leven ALLEEN in seed.sql (lokaal), niet in de prod-migrations.
grant usage on schema tests to authenticated, postgres, service_role;
grant execute on function tests._email_for(uuid) to authenticated, postgres, service_role;
grant execute on function tests.sign_in_as(uuid) to authenticated, postgres, service_role;
grant execute on function tests.sign_out()       to authenticated, postgres, service_role;

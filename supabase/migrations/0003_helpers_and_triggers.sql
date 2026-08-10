-- 0003_helpers_and_triggers.sql
-- Helper-functies gebruikt door RLS-policies + RPCs, plus algemene triggers
-- (updated_at, immutability).

--------------------------------------------------------------------------------
-- Helper: updated_at op elke UPDATE
--------------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
alter function public.set_updated_at() owner to postgres;
-- Defense-in-depth: trigger-only functie; geen EXECUTE-grant nodig voor clients.
revoke execute on function public.set_updated_at() from public;

-- Trigger op elke tabel met een updated_at-kolom
create trigger tg_profiles_updated_at        before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger tg_organizations_updated_at   before update on public.organizations
  for each row execute function public.set_updated_at();
create trigger tg_projects_updated_at        before update on public.projects
  for each row execute function public.set_updated_at();
create trigger tg_project_documents_updated_at before update on public.project_documents
  for each row execute function public.set_updated_at();

--------------------------------------------------------------------------------
-- Helper: is_active_org_member(org_id) — user is actief lid van een actieve org
--------------------------------------------------------------------------------

create or replace function public.is_active_org_member(p_org_id uuid)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select exists(
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = p_org_id
      and m.user_id = auth.uid()
      and m.deleted_at is null
      and m.joined_at is not null
      and o.deleted_at is null
  );
$$;
alter function public.is_active_org_member(uuid) owner to postgres;
revoke execute on function public.is_active_org_member(uuid) from public, anon;
grant  execute on function public.is_active_org_member(uuid) to authenticated;

--------------------------------------------------------------------------------
-- Helper: active_org_role(org_id) — retourneert rol van actieve user in actieve org
--------------------------------------------------------------------------------

create or replace function public.active_org_role(p_org_id uuid)
returns text
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select m.role
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id
  where m.organization_id = p_org_id
    and m.user_id = auth.uid()
    and m.deleted_at is null
    and m.joined_at is not null
    and o.deleted_at is null
  limit 1;
$$;
alter function public.active_org_role(uuid) owner to postgres;
revoke execute on function public.active_org_role(uuid) from public, anon;
grant  execute on function public.active_org_role(uuid) to authenticated;

--------------------------------------------------------------------------------
-- Helper: count_active_owners(org_id)
--------------------------------------------------------------------------------

create or replace function public.count_active_owners(p_org_id uuid)
returns integer
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select count(*)::int
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id
  where m.organization_id = p_org_id
    and m.role = 'owner'
    and m.deleted_at is null
    and m.joined_at is not null
    and o.deleted_at is null;
$$;
alter function public.count_active_owners(uuid) owner to postgres;
revoke execute on function public.count_active_owners(uuid) from public, anon;
grant  execute on function public.count_active_owners(uuid) to authenticated;

--------------------------------------------------------------------------------
-- Helper: active_membership_count(user_id)
-- Gebruikt voor quota-check in create_organization / accept_invitation /
-- restore_member (max 5 actieve organisaties per gebruiker).
--------------------------------------------------------------------------------

create or replace function public.active_membership_count(p_user_id uuid)
returns integer
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select count(*)::int
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = p_user_id
    and m.deleted_at is null
    and m.joined_at is not null
    and o.deleted_at is null;
$$;
alter function public.active_membership_count(uuid) owner to postgres;
revoke execute on function public.active_membership_count(uuid) from public, anon;
grant  execute on function public.active_membership_count(uuid) to authenticated;

--------------------------------------------------------------------------------
-- Helper: active_project_count(org_id)
-- Gebruikt voor quota-check in create_project (max 20 actieve projecten per org).
--------------------------------------------------------------------------------

create or replace function public.active_project_count(p_org_id uuid)
returns integer
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select count(*)::int
  from public.projects
  where organization_id = p_org_id
    and deleted_at is null;
$$;
alter function public.active_project_count(uuid) owner to postgres;
revoke execute on function public.active_project_count(uuid) from public, anon;
grant  execute on function public.active_project_count(uuid) to authenticated;

--------------------------------------------------------------------------------
-- Immutability-trigger voor project_document_versions en document_data_snapshots
--------------------------------------------------------------------------------

create or replace function public.reject_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'row_is_immutable' using errcode = '42501';
end;
$$;
alter function public.reject_mutation() owner to postgres;
-- Defense-in-depth: trigger-only functie; geen EXECUTE-grant nodig voor clients.
revoke execute on function public.reject_mutation() from public;

create trigger tg_ver_no_update
  before update on public.project_document_versions
  for each row execute function public.reject_mutation();
create trigger tg_ver_no_delete
  before delete on public.project_document_versions
  for each row execute function public.reject_mutation();

create trigger tg_data_snap_no_update
  before update on public.document_data_snapshots
  for each row execute function public.reject_mutation();
create trigger tg_data_snap_no_delete
  before delete on public.document_data_snapshots
  for each row execute function public.reject_mutation();

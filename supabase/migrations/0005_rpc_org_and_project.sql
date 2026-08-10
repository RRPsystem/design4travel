-- 0005_rpc_org_and_project.sql
-- Organization- en project-lifecycle-RPCs.
--
-- Quota (harde limieten, niet rate-limited):
--   create_organization : max 5 ACTIEVE memberships per gebruiker
--                         (personal-org telt mee; joined-orgs ook)
--   create_project      : max 20 ACTIEVE projecten per organisatie
--
-- Race-veiligheid: advisory transaction lock per gebruiker (org-create) resp.
-- per organisatie (project-create) zorgt dat gelijktijdige calls niet allebei
-- door de quota-check glippen.
--
-- (De echte rate limit — invite_member 30/uur/org — leeft in 0007.)

--------------------------------------------------------------------------------
-- create_organization
-- Atomair: org + owner-membership in één transactie.
-- Vertrouwt uitsluitend auth.uid(); geen client-parameter voor created_by.
-- Quota-check via advisory lock om race te voorkomen.
--------------------------------------------------------------------------------

create or replace function public.create_organization(p_name text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid       uuid := auth.uid();
  v_org_id    uuid;
  v_mem_count integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- Slug- en naam-validatie (CHECK-constraints in 0002 handhaven dit ook, hier
  -- vroeger falen met leesbare error).
  -- LET OP: exact dezelfde regex als chk_org_slug_shape in 0002_schema.sql —
  -- als je hier iets wijzigt, wijzig ook de CHECK-constraint (en verifieer dat
  -- de personal-workspace-slug in 0009_auth_hooks.sql nog voldoet).
  if p_slug is null or p_slug !~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$' then
    raise exception 'invalid_slug' using errcode = '22023';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 80 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  -- Advisory lock op deze gebruiker — serialiseert alle mutaties op zijn
  -- membership-set (create_organization / accept_invitation / restore_member),
  -- zodat de quota-check hierna consistent is.
  perform pg_advisory_xact_lock(hashtext('membership_set:' || v_uid::text));

  v_mem_count := public.active_membership_count(v_uid);
  if v_mem_count >= 5 then
    raise exception 'membership_quota_exceeded'
      using errcode = '23514',
            detail = 'active_memberships=' || v_mem_count::text;
  end if;

  insert into public.organizations (name, slug, created_by)
    values (p_name, p_slug, v_uid)
    returning id into v_org_id;

  insert into public.organization_members
    (organization_id, user_id, role, invited_by, joined_at)
    values (v_org_id, v_uid, 'owner', v_uid, now());

  return v_org_id;
end $$;
alter function public.create_organization(text, text) owner to postgres;
revoke execute on function public.create_organization(text, text) from public, anon;
grant  execute on function public.create_organization(text, text) to authenticated;

--------------------------------------------------------------------------------
-- soft_delete_organization  (owner-only, FOR UPDATE op org)
--------------------------------------------------------------------------------

create or replace function public.soft_delete_organization(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- Exclusive lock op de org-rij — serialiseert met alle andere org-mutaties
  perform 1 from public.organizations
    where id = p_org_id and deleted_at is null
    for update;
  if not found then
    raise exception 'organization_not_active' using errcode = '22023';
  end if;

  -- LET OP: active_org_role() geeft NULL voor non-members. `NULL <> 'owner'`
  -- is NULL, en `if NULL then` = false — zonder expliciete null-guard zou de
  -- raise stilletjes worden overgeslagen (dezelfde valkuil in
  -- create_project / invite_member / revoke_invitation / set_external_org_ref).
  v_role := public.active_org_role(p_org_id);
  if v_role is null or v_role <> 'owner' then
    raise exception 'only_owner' using errcode = '42501';
  end if;

  update public.organizations
    set deleted_at = now()
    where id = p_org_id;
end $$;
alter function public.soft_delete_organization(uuid) owner to postgres;
revoke execute on function public.soft_delete_organization(uuid) from public, anon;
grant  execute on function public.soft_delete_organization(uuid) to authenticated;

--------------------------------------------------------------------------------
-- set_external_org_ref  (owner-only)
--------------------------------------------------------------------------------

create or replace function public.set_external_org_ref(p_org_id uuid, p_ref text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  perform 1 from public.organizations
    where id = p_org_id and deleted_at is null for share;
  if not found then
    raise exception 'organization_not_active' using errcode = '22023';
  end if;
  -- active_org_role() null-guard: zie soft_delete_organization.
  v_role := public.active_org_role(p_org_id);
  if v_role is null or v_role <> 'owner' then
    raise exception 'only_owner' using errcode = '42501';
  end if;
  update public.organizations
    set external_org_ref = p_ref
    where id = p_org_id;
end $$;
alter function public.set_external_org_ref(uuid, text) owner to postgres;
revoke execute on function public.set_external_org_ref(uuid, text) from public, anon;
grant  execute on function public.set_external_org_ref(uuid, text) to authenticated;

--------------------------------------------------------------------------------
-- create_project
--------------------------------------------------------------------------------

create or replace function public.create_project(
  p_org_id        uuid,
  p_name          text,
  p_document_type text,
  p_description   text default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid          uuid := auth.uid();
  v_project_id   uuid;
  v_proj_count   integer;
  v_role         text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- FOR SHARE op organizations — blokkeert soft-delete tijdens creatie
  perform 1 from public.organizations
    where id = p_org_id and deleted_at is null for share;
  if not found then
    raise exception 'organization_not_active' using errcode = '22023';
  end if;

  -- active_org_role() null-guard: zie soft_delete_organization.
  v_role := public.active_org_role(p_org_id);
  if v_role is null or v_role not in ('owner','admin','editor') then
    raise exception 'insufficient_role' using errcode = '42501';
  end if;

  if p_document_type not in ('website','offerte','roadbook','brochure','social','document') then
    raise exception 'invalid_document_type' using errcode = '22023';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 200 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  -- Advisory lock op de organisatie — serialiseert alle project-quota-checks
  -- binnen deze org zodat de count() hierna consistent is.
  perform pg_advisory_xact_lock(hashtext('project_set:' || p_org_id::text));

  v_proj_count := public.active_project_count(p_org_id);
  if v_proj_count >= 20 then
    raise exception 'project_quota_exceeded'
      using errcode = '23514',
            detail = 'active_projects=' || v_proj_count::text;
  end if;

  insert into public.projects
    (organization_id, name, description, document_type, created_by)
    values (p_org_id, p_name, p_description, p_document_type, v_uid)
    returning id into v_project_id;

  return v_project_id;
end $$;
alter function public.create_project(uuid, text, text, text) owner to postgres;
revoke execute on function public.create_project(uuid, text, text, text) from public, anon;
grant  execute on function public.create_project(uuid, text, text, text) to authenticated;

--------------------------------------------------------------------------------
-- soft_delete_project
-- owner/admin altijd; editor alleen als created_by = auth.uid()
--------------------------------------------------------------------------------

create or replace function public.soft_delete_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid        uuid := auth.uid();
  v_org_id     uuid;
  v_created_by uuid;
  v_role       text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select organization_id, created_by
    into v_org_id, v_created_by
    from public.projects
    where id = p_project_id and deleted_at is null
    for update;
  if not found then
    raise exception 'project_not_active' using errcode = '22023';
  end if;

  -- FOR SHARE op organizations om concurrente org-soft-delete te blokkeren
  perform 1 from public.organizations
    where id = v_org_id and deleted_at is null for share;
  if not found then
    raise exception 'organization_not_active' using errcode = '22023';
  end if;

  v_role := public.active_org_role(v_org_id);
  if v_role in ('owner','admin')
     or (v_role = 'editor' and v_created_by = v_uid) then
    update public.projects
      set deleted_at = now()
      where id = p_project_id;
  else
    raise exception 'insufficient_role_for_delete' using errcode = '42501';
  end if;
end $$;
alter function public.soft_delete_project(uuid) owner to postgres;
revoke execute on function public.soft_delete_project(uuid) from public, anon;
grant  execute on function public.soft_delete_project(uuid) to authenticated;

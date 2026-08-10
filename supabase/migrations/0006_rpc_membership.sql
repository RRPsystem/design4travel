-- 0006_rpc_membership.sql
--
-- Alle vier RPCs die de owner-set kunnen raken nemen ALTIJD eerst
-- FOR UPDATE op de organizations-rij. Dat serialiseert owner-mutaties per
-- organisatie zonder racegevoelige voorafclassificatie.
--
-- Definitieve lockvolgorde: organizations → organization_members
-- (documenten worden hier niet aangeraakt)

--------------------------------------------------------------------------------
-- change_member_role
--------------------------------------------------------------------------------

create or replace function public.change_member_role(p_member_id uuid, p_new_role text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid        uuid := auth.uid();
  v_target_org uuid;
  v_target     record;
  v_actor_role text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_new_role not in ('owner','admin','editor','viewer') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;

  select organization_id into v_target_org
    from public.organization_members where id = p_member_id;
  if not found then raise exception 'not_found' using errcode = '42704'; end if;

  -- Stap A: FOR UPDATE op organizations — serialiseert alle owner-mutaties
  perform 1 from public.organizations
    where id = v_target_org and deleted_at is null for update;
  if not found then raise exception 'organization_not_active' using errcode = '22023'; end if;

  -- Stap B: FOR UPDATE op de doel-membership
  select * into v_target
    from public.organization_members
    where id = p_member_id and deleted_at is null
    for update;
  if not found then raise exception 'not_found_or_deleted' using errcode = '42704'; end if;

  -- Stap C: rol van actor NA org-lock (racevrij)
  v_actor_role := public.active_org_role(v_target_org);
  if v_actor_role is null or v_actor_role not in ('owner','admin') then
    raise exception 'insufficient_role' using errcode = '42501';
  end if;

  -- Owner-scope
  if (v_target.role = 'owner' or p_new_role = 'owner') and v_actor_role <> 'owner' then
    raise exception 'only_owner_manages_owner_role' using errcode = '42501';
  end if;
  if v_target.user_id = v_uid then
    raise exception 'cannot_change_own_role' using errcode = '42501';
  end if;

  -- Last-owner-invariant NA org-lock
  if v_target.role = 'owner' and p_new_role <> 'owner'
     and public.count_active_owners(v_target_org) <= 1 then
    raise exception 'cannot_degrade_last_owner' using errcode = '42501';
  end if;

  if v_target.role = p_new_role then return; end if;

  update public.organization_members
    set role = p_new_role
    where id = p_member_id;
end $$;
alter function public.change_member_role(uuid, text) owner to postgres;
revoke execute on function public.change_member_role(uuid, text) from public, anon;
grant  execute on function public.change_member_role(uuid, text) to authenticated;

--------------------------------------------------------------------------------
-- remove_member  (iemand anders — self-removal via leave_organization)
--------------------------------------------------------------------------------

create or replace function public.remove_member(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid        uuid := auth.uid();
  v_target_org uuid;
  v_target     record;
  v_actor_role text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  select organization_id into v_target_org
    from public.organization_members where id = p_member_id;
  if not found then raise exception 'not_found' using errcode = '42704'; end if;

  perform 1 from public.organizations
    where id = v_target_org and deleted_at is null for update;
  if not found then raise exception 'organization_not_active' using errcode = '22023'; end if;

  select * into v_target
    from public.organization_members
    where id = p_member_id and deleted_at is null
    for update;
  if not found then raise exception 'not_found_or_deleted' using errcode = '42704'; end if;

  if v_target.user_id = v_uid then
    raise exception 'use_leave_organization' using errcode = '42501';
  end if;

  v_actor_role := public.active_org_role(v_target_org);
  if v_actor_role is null or v_actor_role not in ('owner','admin') then
    raise exception 'insufficient_role' using errcode = '42501';
  end if;

  if v_target.role = 'owner' then
    if v_actor_role <> 'owner' then
      raise exception 'only_owner_removes_owner' using errcode = '42501';
    end if;
    if public.count_active_owners(v_target_org) <= 1 then
      raise exception 'cannot_remove_last_owner' using errcode = '42501';
    end if;
  end if;

  update public.organization_members
    set deleted_at = now()
    where id = p_member_id;
end $$;
alter function public.remove_member(uuid) owner to postgres;
revoke execute on function public.remove_member(uuid) from public, anon;
grant  execute on function public.remove_member(uuid) to authenticated;

--------------------------------------------------------------------------------
-- leave_organization (self)
--------------------------------------------------------------------------------

create or replace function public.leave_organization(p_org_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid    uuid := auth.uid();
  v_target record;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  perform 1 from public.organizations
    where id = p_org_id and deleted_at is null for update;
  if not found then raise exception 'organization_not_active' using errcode = '22023'; end if;

  select * into v_target
    from public.organization_members
    where organization_id = p_org_id
      and user_id = v_uid
      and deleted_at is null
      and joined_at is not null
    for update;
  if not found then raise exception 'not_active_member' using errcode = '42501'; end if;

  if v_target.role = 'owner'
     and public.count_active_owners(p_org_id) <= 1 then
    raise exception 'cannot_leave_as_last_owner' using errcode = '42501';
  end if;

  update public.organization_members
    set deleted_at = now()
    where id = v_target.id;
end $$;
alter function public.leave_organization(uuid) owner to postgres;
revoke execute on function public.leave_organization(uuid) from public, anon;
grant  execute on function public.leave_organization(uuid) to authenticated;

--------------------------------------------------------------------------------
-- restore_member (owner-only, org-lock)
--------------------------------------------------------------------------------

create or replace function public.restore_member(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_target_org uuid;
  v_target     record;
  v_actor_role text;
  v_target_cnt integer;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  select organization_id into v_target_org
    from public.organization_members where id = p_member_id;
  if not found then raise exception 'not_found' using errcode = '42704'; end if;

  perform 1 from public.organizations
    where id = v_target_org and deleted_at is null for update;
  if not found then raise exception 'organization_not_active' using errcode = '22023'; end if;

  select * into v_target
    from public.organization_members
    where id = p_member_id and deleted_at is not null
    for update;
  if not found then raise exception 'not_found_or_active' using errcode = '42704'; end if;

  v_actor_role := public.active_org_role(v_target_org);
  if v_actor_role <> 'owner' then
    raise exception 'only_owner_restores' using errcode = '42501';
  end if;

  -- Voorkom clash met bestaand actief membership (unique-index vangt anders af)
  if exists (
    select 1 from public.organization_members
    where organization_id = v_target_org
      and user_id = v_target.user_id
      and deleted_at is null
  ) then
    raise exception 'active_membership_already_exists' using errcode = '23505';
  end if;

  -- Quota-check op de TARGET-user (niet de actor): restore mag alleen als target
  -- < 5 actieve memberships heeft. Advisory lock op de target user.
  perform pg_advisory_xact_lock(hashtext('membership_set:' || v_target.user_id::text));
  v_target_cnt := public.active_membership_count(v_target.user_id);
  if v_target_cnt >= 5 then
    raise exception 'target_membership_quota_exceeded'
      using errcode = '23514',
            detail = 'target_active_memberships=' || v_target_cnt::text;
  end if;

  update public.organization_members
    set deleted_at = null
    where id = p_member_id;
end $$;
alter function public.restore_member(uuid) owner to postgres;
revoke execute on function public.restore_member(uuid) from public, anon;
grant  execute on function public.restore_member(uuid) to authenticated;

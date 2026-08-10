-- 0008_rpc_documents.sql
--
-- Twee RPCs, beide met dezelfde canonieke lockketen:
--   organizations(share) → projects(share) → organization_members(update)
--                        → project_documents(update)
--
--   create_document_snapshot(project_document_id, note?)
--     - EXECUTE aan `authenticated`.
--     - Leest bestaande doc, schrijft immutable version-row.
--     - Herbevestigt actief-membership + rol NA de member-lock, zodat een
--       tegelijk uitgevoerde remove_member/soft_delete_organization/
--       soft_delete_project geen snapshot meer kan laten schrijven met een
--       inmiddels ingetrokken rol.
--     - Race-vrij versienummer via FOR UPDATE op parent-document.
--
--   save_document_internal(actor_user_id, project_id, doc, schema_version,
--                          expected_lock_version)
--     - EXECUTE UITSLUITEND aan `service_role`.
--     - Aangeroepen door de Edge Function `save-document` NA Zod-validatie.
--     - Zelfde lockketen; optimistic-lock via `lock_version`.

--------------------------------------------------------------------------------
-- create_document_snapshot  (authenticated)
--------------------------------------------------------------------------------

create or replace function public.create_document_snapshot(
  p_project_document_id uuid,
  p_note                text default null
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid           uuid := auth.uid();
  v_org_id        uuid;
  v_project_id    uuid;
  v_role          text;
  v_version_id    uuid;
  v_next          integer;
  v_doc           jsonb;
  v_schema_ver    text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  -- Stap 0: bepaal org+project zonder lock zodat we de canonieke lockketen
  -- (org → project → member → doc) daarna in de juiste volgorde kunnen nemen.
  select p.organization_id, p.id
    into v_org_id, v_project_id
    from public.project_documents d
    join public.projects p on p.id = d.project_id
    where d.id = p_project_document_id;
  if not found then raise exception 'not_found' using errcode = '42704'; end if;

  -- Stap A: organizations FOR SHARE — blokkeert soft_delete_organization
  perform 1 from public.organizations
    where id = v_org_id and deleted_at is null for share;
  if not found then raise exception 'organization_not_active' using errcode = '22023'; end if;

  -- Stap B: projects FOR SHARE — blokkeert soft_delete_project
  perform 1 from public.projects
    where id = v_project_id and deleted_at is null for share;
  if not found then raise exception 'project_not_active' using errcode = '22023'; end if;

  -- Stap C: organization_members FOR UPDATE — serialiseert met remove_member /
  -- change_member_role / leave_organization, zodat rol- en membershipstatus
  -- ná de lock stabiel is voor de rest van de transactie.
  select role into v_role
    from public.organization_members
    where organization_id = v_org_id
      and user_id = v_uid
      and deleted_at is null
      and joined_at is not null
    for update;
  if not found then raise exception 'membership_not_active' using errcode = '42501'; end if;
  if v_role not in ('owner','admin','editor') then
    raise exception 'insufficient_role' using errcode = '42501';
  end if;

  -- Stap D: project_documents FOR UPDATE — race-vrij versienummer + read van
  -- de actuele doc (snapshot ziet exact wat op dit moment saved is).
  select doc, schema_version
    into v_doc, v_schema_ver
    from public.project_documents
    where id = p_project_document_id
    for update;
  if not found then raise exception 'document_not_found' using errcode = '42704'; end if;

  select coalesce(max(version_number), 0) + 1 into v_next
    from public.project_document_versions
    where project_document_id = p_project_document_id;

  insert into public.project_document_versions
    (project_document_id, version_number, doc, schema_version, author_id, author_note)
  values
    (p_project_document_id, v_next, v_doc, v_schema_ver, v_uid, p_note)
  returning id into v_version_id;

  return v_version_id;
end $$;
alter function public.create_document_snapshot(uuid, text) owner to postgres;
revoke execute on function public.create_document_snapshot(uuid, text) from public, anon;
grant  execute on function public.create_document_snapshot(uuid, text) to authenticated;

--------------------------------------------------------------------------------
-- save_document_internal  (service_role ONLY)
--
-- Wordt aangeroepen door de Edge Function `save-document` NA:
--   1. JWT-verificatie via Supabase Auth (getUser)
--   2. Zod-schema-validatie op p_doc
--   3. Schema-versie-check tegen actuele SCHEMA_VERSION
--
-- p_actor_user_id komt uit de geverifieerde JWT — NOOIT uit de request-body.
--
-- Volledige lockketen: organizations(share) → projects(share)
--                     → organization_members(update) → project_documents(update)
--------------------------------------------------------------------------------

create or replace function public.save_document_internal(
  p_actor_user_id         uuid,
  p_project_id            uuid,
  p_doc                   jsonb,
  p_schema_version        text,
  p_expected_lock_version integer
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org_id       uuid;
  v_doc_id       uuid;
  v_current_lock integer;
  v_role         text;
begin
  if p_actor_user_id is null then
    raise exception 'missing_actor_user_id' using errcode = '28000';
  end if;

  select organization_id into v_org_id
    from public.projects where id = p_project_id;
  if not found then raise exception 'project_not_found' using errcode = '42704'; end if;

  perform 1 from public.organizations
    where id = v_org_id and deleted_at is null for share;
  if not found then raise exception 'organization_not_active' using errcode = '22023'; end if;

  perform 1 from public.projects
    where id = p_project_id and deleted_at is null for share;
  if not found then raise exception 'project_not_active' using errcode = '22023'; end if;

  select role into v_role
    from public.organization_members
    where organization_id = v_org_id
      and user_id = p_actor_user_id
      and deleted_at is null
      and joined_at is not null
    for update;
  if not found then raise exception 'membership_not_active' using errcode = '42501'; end if;
  if v_role not in ('owner','admin','editor') then
    raise exception 'insufficient_role' using errcode = '42501';
  end if;

  select id, lock_version into v_doc_id, v_current_lock
    from public.project_documents
    where project_id = p_project_id
    for update;
  if not found then raise exception 'document_not_found' using errcode = '42704'; end if;
  if v_current_lock <> p_expected_lock_version then
    raise exception 'lock_version_mismatch'
      using errcode = '55P03', detail = 'current=' || v_current_lock::text;
  end if;

  update public.project_documents
     set doc            = p_doc,
         schema_version = p_schema_version,
         updated_by     = p_actor_user_id,
         updated_at     = now(),
         lock_version   = lock_version + 1
   where id = v_doc_id;

  return v_current_lock + 1;
end $$;
alter function public.save_document_internal(uuid, uuid, jsonb, text, integer) owner to postgres;
revoke execute on function public.save_document_internal(uuid, uuid, jsonb, text, integer)
  from public, anon, authenticated;
grant  execute on function public.save_document_internal(uuid, uuid, jsonb, text, integer)
  to service_role;

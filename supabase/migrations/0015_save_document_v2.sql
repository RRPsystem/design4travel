-- 0015_save_document_v2.sql
--
-- Zero-downtime introductie van document-id-key save-RPC.
--
-- De originele save_document_internal (0008) zocht het target-document via
-- project_id (want er was max 1 doc per project). Na migratie 0014 kunnen
-- er meerdere docs per project bestaan, dus die aanname vervalt.
--
-- Aanpak: NIEUWE RPC save_document_v2_internal die document_id direct
-- accepteert. Oude save_document_internal blijft bestaan zonder wijziging,
-- zodat de Edge Function 'save-document' de switch-over zelf kan
-- kiezen (backward-compat: als de body een project_id bevat, kijkt de
-- Edge Function het (enige) doc op en delegate't dan naar v2). Later
-- (na frontend-migratie naar document_id) kunnen we v1 retire'n via een
-- expliciete drop-migration.
--
-- Verschillen met v1:
--   - key = document_id i.p.v. project_id
--   - roles-check gebeurt via join naar projects (want project-id komt niet
--     meer als arg binnen)
--   - lockketen: organizations(share) → projects(share) →
--     organization_members(update) → project_documents(update, keyed op id)

create or replace function public.save_document_v2_internal(
  p_actor_user_id         uuid,
  p_document_id           uuid,
  p_doc                   jsonb,
  p_schema_version        text,
  p_expected_lock_version integer
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_project_id   uuid;
  v_org_id       uuid;
  v_current_lock integer;
  v_role         text;
begin
  if p_actor_user_id is null then
    raise exception 'missing_actor_user_id' using errcode = '28000';
  end if;

  -- Stap 0: haal project + org op via het document. Geen lock nog — die volgen
  -- in de canonieke lockketen.
  select d.project_id, p.organization_id
    into v_project_id, v_org_id
    from public.project_documents d
    join public.projects p on p.id = d.project_id
    where d.id = p_document_id;
  if not found then
    raise exception 'document_not_found' using errcode = '42704';
  end if;

  -- Stap A: organizations FOR SHARE — blokkeert soft_delete_organization
  perform 1 from public.organizations
    where id = v_org_id and deleted_at is null for share;
  if not found then raise exception 'organization_not_active' using errcode = '22023'; end if;

  -- Stap B: projects FOR SHARE — blokkeert soft_delete_project
  perform 1 from public.projects
    where id = v_project_id and deleted_at is null for share;
  if not found then raise exception 'project_not_active' using errcode = '22023'; end if;

  -- Stap C: organization_members FOR UPDATE — serialiseert met remove_member /
  -- change_member_role / leave_organization
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

  -- Stap D: project_documents FOR UPDATE + optimistic-lock check
  select lock_version into v_current_lock
    from public.project_documents
    where id = p_document_id
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
   where id = p_document_id;

  return v_current_lock + 1;
end $$;

alter function public.save_document_v2_internal(uuid, uuid, jsonb, text, integer)
  owner to postgres;
revoke execute on function public.save_document_v2_internal(uuid, uuid, jsonb, text, integer)
  from public, anon, authenticated;
grant  execute on function public.save_document_v2_internal(uuid, uuid, jsonb, text, integer)
  to service_role;

-- 0016_project_document_lifecycle_rpcs.sql
--
-- Lifecycle-RPCs die de dashboard-UX + multi-doc workflow ondersteunen.
--
--   create_project_document(project_id, document_type, title, seed_doc,
--                           schema_version)
--     Nieuwe doc binnen een bestaand project. Service-role only — de Edge
--     Function `create-document` verifieert JWT + rol vooraf.
--     Idempotency: NIET per (project_id, title) — twee docs met dezelfde
--     titel zijn toegestaan.
--     Quota: geen aparte quota per project — projecten hebben al een
--     quota (20 actieve projecten per org uit 0005). Verwachting is
--     dat 20 projecten × N docs schaalbaar genoeg is voor v1.
--
--   duplicate_project(source_id, new_name)
--     Deep-copy: nieuw project + kopie van elk project_document. GEEN
--     versie-historie mee-copiëren (start met versie 0 op nieuw project).
--     Bootstrap-lock rond de creatie i.v.m. quota.
--     Aangeroepen als authenticated (SECURITY DEFINER met auth.uid()).
--
--   restore_project(id)
--     Un-soft-delete. Owner/admin only. Respecteert quota (20/org).

--------------------------------------------------------------------------------
-- create_project_document
--------------------------------------------------------------------------------

create or replace function public.create_project_document(
  p_actor_user_id  uuid,
  p_project_id     uuid,
  p_document_type  text,
  p_title          text,
  p_seed_doc       jsonb,
  p_schema_version text
) returns table(
  project_document_id uuid,
  lock_version        integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org_id     uuid;
  v_role       text;
  v_doc_id     uuid;
  v_lock_ver   integer;
begin
  if p_actor_user_id is null then
    raise exception 'missing_actor_user_id' using errcode = '28000';
  end if;

  if p_document_type not in ('website','offerte','roadbook','brochure','social','document') then
    raise exception 'invalid_document_type' using errcode = '22023';
  end if;
  if p_title is null or char_length(trim(p_title)) not between 1 and 200 then
    raise exception 'invalid_title' using errcode = '22023';
  end if;
  if p_schema_version is null or char_length(trim(p_schema_version)) = 0 then
    raise exception 'invalid_schema_version' using errcode = '22023';
  end if;
  if p_seed_doc is null or jsonb_typeof(p_seed_doc) <> 'object' then
    raise exception 'invalid_seed_doc' using errcode = '22023';
  end if;

  -- Bepaal org via project (voor member-check)
  select organization_id into v_org_id
    from public.projects
    where id = p_project_id and deleted_at is null;
  if not found then raise exception 'project_not_active' using errcode = '22023'; end if;

  -- Canonieke lockketen: org(share) → project(share) → member(update)
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

  insert into public.project_documents
    (project_id, doc, schema_version, updated_by, lock_version, document_type, title)
    values (p_project_id, p_seed_doc, p_schema_version, p_actor_user_id, 1, p_document_type, p_title)
    returning
      public.project_documents.id,
      public.project_documents.lock_version
      into v_doc_id, v_lock_ver;

  project_document_id := v_doc_id;
  lock_version        := v_lock_ver;
  return next;
end $$;

alter function public.create_project_document(uuid, uuid, text, text, jsonb, text)
  owner to postgres;
revoke execute on function public.create_project_document(uuid, uuid, text, text, jsonb, text)
  from public, anon, authenticated;
grant  execute on function public.create_project_document(uuid, uuid, text, text, jsonb, text)
  to service_role;

--------------------------------------------------------------------------------
-- duplicate_project
--
-- Authenticated call (net als create_project). Quota-check hergebruikt
-- active_project_count()-helper uit 0003. Advisory lock op de doel-org.
--------------------------------------------------------------------------------

create or replace function public.duplicate_project(
  p_source_project_id uuid,
  p_new_name          text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid           uuid := auth.uid();
  v_org_id        uuid;
  v_source_desc   text;
  v_source_type   text;
  v_role          text;
  v_proj_count    integer;
  v_new_proj_id   uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if p_new_name is null or char_length(trim(p_new_name)) not between 1 and 200 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  -- Bron-project laden + FOR UPDATE op de rij zodat concurrent soft-delete
  -- niet halverwege alsnog geldt.
  select organization_id, description, document_type
    into v_org_id, v_source_desc, v_source_type
    from public.projects
    where id = p_source_project_id and deleted_at is null
    for update;
  if not found then raise exception 'source_project_not_active' using errcode = '22023'; end if;

  -- Org FOR SHARE tegen soft-delete-organization
  perform 1 from public.organizations
    where id = v_org_id and deleted_at is null for share;
  if not found then raise exception 'organization_not_active' using errcode = '22023'; end if;

  -- Rol-check op de user in deze org
  v_role := public.active_org_role(v_org_id);
  if v_role is null or v_role not in ('owner','admin','editor') then
    raise exception 'insufficient_role' using errcode = '42501';
  end if;

  -- Advisory lock op project-set van deze org — voorkomt dat parallelle
  -- duplicate/create beide door de quota-check glippen.
  perform pg_advisory_xact_lock(hashtext('project_set:' || v_org_id::text));

  v_proj_count := public.active_project_count(v_org_id);
  if v_proj_count >= 20 then
    raise exception 'project_quota_exceeded'
      using errcode = '23514',
            detail = 'active_projects=' || v_proj_count::text;
  end if;

  -- Nieuw project. document_type blijft primary-type van de bron.
  insert into public.projects
    (organization_id, name, description, document_type, created_by)
    values (v_org_id, p_new_name, v_source_desc, v_source_type, v_uid)
    returning id into v_new_proj_id;

  -- Kopieer elk project_document van de bron. Version-history NIET
  -- mee-copiëren (nieuwe project start met versie 0 op elke doc; volgende
  -- save schrijft lock_version=2 met snapshot=1).
  insert into public.project_documents
    (project_id, doc, schema_version, updated_by, lock_version,
     document_type, title)
    select v_new_proj_id,
           doc,
           schema_version,
           v_uid,           -- created-by voor kopie is de duplicator
           1,               -- lock_version-reset
           document_type,
           title
      from public.project_documents
     where project_id = p_source_project_id;

  return v_new_proj_id;
end $$;

alter function public.duplicate_project(uuid, text) owner to postgres;
revoke execute on function public.duplicate_project(uuid, text) from public, anon;
grant  execute on function public.duplicate_project(uuid, text) to authenticated;

--------------------------------------------------------------------------------
-- restore_project
--
-- Un-soft-delete een gearchiveerd project. Alleen owner/admin.
-- Respecteert de 20-per-org quota — als de org al vol zit met actieve
-- projecten kan er niet extra bijkomen via restore.
--------------------------------------------------------------------------------

create or replace function public.restore_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid        uuid := auth.uid();
  v_org_id     uuid;
  v_role       text;
  v_proj_count integer;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- Project moet zijn gearchiveerd (deleted_at IS NOT NULL). FOR UPDATE
  -- om race met concurrent restore/hard-delete uit te sluiten.
  select organization_id into v_org_id
    from public.projects
    where id = p_project_id and deleted_at is not null
    for update;
  if not found then raise exception 'project_not_archived' using errcode = '22023'; end if;

  -- Org moet zelf actief zijn — anders kan restore geen zin hebben.
  perform 1 from public.organizations
    where id = v_org_id and deleted_at is null for share;
  if not found then raise exception 'organization_not_active' using errcode = '22023'; end if;

  -- Alleen owner/admin (editor kan zelf een eigen project soft-deleten via
  -- 0005 maar restore is admin-taak).
  v_role := public.active_org_role(v_org_id);
  if v_role is null or v_role not in ('owner','admin') then
    raise exception 'insufficient_role' using errcode = '42501';
  end if;

  -- Quota-check op actieve projecten (restore telt mee als een nieuwe
  -- actieve). Advisory lock om race met create/duplicate te vermijden.
  perform pg_advisory_xact_lock(hashtext('project_set:' || v_org_id::text));

  v_proj_count := public.active_project_count(v_org_id);
  if v_proj_count >= 20 then
    raise exception 'project_quota_exceeded'
      using errcode = '23514',
            detail = 'active_projects=' || v_proj_count::text;
  end if;

  update public.projects
     set deleted_at = null,
         updated_at = now()
   where id = p_project_id;
end $$;

alter function public.restore_project(uuid) owner to postgres;
revoke execute on function public.restore_project(uuid) from public, anon;
grant  execute on function public.restore_project(uuid) to authenticated;

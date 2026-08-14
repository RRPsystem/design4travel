-- 0017_create_project_with_first_document.sql
--
-- Atomische creatie van project + eerste document.
--
-- Waarom nieuw naast de bestaande RPCs:
--   - create_project (0005) maakt ALLEEN een project (zonder doc).
--   - create_project_document (0016) maakt een doc BINNEN een bestaand project.
--   - Als de frontend deze twee losse stappen achter elkaar zou aanroepen en
--     stap 2 faalt (netwerk, RLS, race, ...), blijft er een leeg project
--     achter. Niet acceptabel voor de "Nieuw project"-UX.
--
-- Deze RPC combineert beide in ÉÉN transactie. Bij een fout in de doc-insert
-- rolt PostgreSQL de hele transactie terug (inclusief de project-insert),
-- dus geen dangling state.
--
-- Wat betreft `projects.document_type`:
--   Blijft NOT NULL voor backward-compat. We zetten hem op p_first_document_type
--   (het type van het eerste doc). Als de user later docs van ander type
--   toevoegt (via create_project_document uit 0016), heeft die zijn eigen
--   document_type op project_documents. project_documents.document_type is
--   dus authoritative per-doc; projects.document_type is 'primary type'
--   (dat van het eerste doc dat er ooit in stond).
--
-- Verschil met bootstrap-RPC (0011): geen idempotency-per-org check. Dit is
-- een DELIBERATE create; als je 'm twee keer aanroept met dezelfde args krijg
-- je twee projecten (mits binnen de 20-per-org quota). Bootstrap doet
-- idempotent-return; deze niet.

create or replace function public.create_project_with_first_document(
  p_actor_user_id       uuid,
  p_org_id              uuid,
  p_project_name        text,
  p_project_description text,
  p_first_document_type text,
  p_first_document_title text,
  p_seed_doc            jsonb,
  p_schema_version      text
) returns table(
  project_id          uuid,
  project_document_id uuid,
  lock_version        integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role         text;
  v_project_id   uuid;
  v_doc_id       uuid;
  v_lock_ver     integer;
  v_proj_count   integer;
begin
  if p_actor_user_id is null then
    raise exception 'missing_actor_user_id' using errcode = '28000';
  end if;

  if p_first_document_type not in ('website','offerte','roadbook','brochure','social','document') then
    raise exception 'invalid_document_type' using errcode = '22023';
  end if;
  if p_project_name is null or char_length(trim(p_project_name)) not between 1 and 200 then
    raise exception 'invalid_project_name' using errcode = '22023';
  end if;
  if p_first_document_title is null or char_length(trim(p_first_document_title)) not between 1 and 200 then
    raise exception 'invalid_document_title' using errcode = '22023';
  end if;
  if p_schema_version is null or char_length(trim(p_schema_version)) = 0 then
    raise exception 'invalid_schema_version' using errcode = '22023';
  end if;
  if p_seed_doc is null or jsonb_typeof(p_seed_doc) <> 'object' then
    raise exception 'invalid_seed_doc' using errcode = '22023';
  end if;

  -- Canonieke lockketen: organizations(share) → member-check(update) → quota
  perform 1 from public.organizations
    where id = p_org_id and deleted_at is null for share;
  if not found then raise exception 'organization_not_active' using errcode = '22023'; end if;

  select role into v_role
    from public.organization_members
    where organization_id = p_org_id
      and user_id = p_actor_user_id
      and deleted_at is null
      and joined_at is not null
    for update;
  if not found then raise exception 'membership_not_active' using errcode = '42501'; end if;
  if v_role not in ('owner','admin','editor') then
    raise exception 'insufficient_role' using errcode = '42501';
  end if;

  -- Advisory lock op de project-set van deze org — hergebruikt exact dezelfde
  -- hash-tag als create_project (0005) en duplicate_project (0016) zodat alle
  -- create/duplicate/restore-races binnen één org serieel afgehandeld worden.
  perform pg_advisory_xact_lock(hashtext('project_set:' || p_org_id::text));

  v_proj_count := public.active_project_count(p_org_id);
  if v_proj_count >= 20 then
    raise exception 'project_quota_exceeded'
      using errcode = '23514',
            detail = 'active_projects=' || v_proj_count::text;
  end if;

  -- INSERT 1: project. projects.document_type = eerste-doc-type.
  -- Als deze insert faalt (bv. onverwacht CHECK-violation): raise, hele
  -- transactie rolt terug — geen leeg project achter.
  insert into public.projects
    (organization_id, name, description, document_type, created_by)
    values (p_org_id, p_project_name, p_project_description, p_first_document_type, p_actor_user_id)
    returning id into v_project_id;

  -- INSERT 2: eerste document. Als deze faalt (chk_doc_shape defence-in-
  -- depth of iets anders): PostgreSQL rolt beide inserts terug. Atomair.
  insert into public.project_documents
    (project_id, doc, schema_version, updated_by, lock_version,
     document_type, title)
    values (v_project_id, p_seed_doc, p_schema_version, p_actor_user_id, 1,
            p_first_document_type, p_first_document_title)
    returning
      public.project_documents.id,
      public.project_documents.lock_version
      into v_doc_id, v_lock_ver;

  project_id          := v_project_id;
  project_document_id := v_doc_id;
  lock_version        := v_lock_ver;
  return next;
end $$;

alter function public.create_project_with_first_document(uuid, uuid, text, text, text, text, jsonb, text)
  owner to postgres;
revoke execute on function public.create_project_with_first_document(uuid, uuid, text, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant  execute on function public.create_project_with_first_document(uuid, uuid, text, text, text, text, jsonb, text)
  to service_role;

-- 0012_fix_create_project_ambiguous_lockversion.sql
--
-- Bugfix voor migration 0011 `create_project_and_document_internal`.
--
-- Symptoom: het CREATE-pad (nieuwe org zonder project) faalde in productie
-- met SQLSTATE 42702:
--
--   ERROR: 42702: column reference "lock_version" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--   QUERY:  insert into public.project_documents ...
--             returning id, lock_version into v_doc_id, v_lock_ver;
--
-- Oorzaak: de functie retourneert `table(project_id, project_document_id,
-- lock_version)`. De OUT-parameter `lock_version` staat in PL/pgSQL's
-- variabele-scope en schaduwt daardoor `project_documents.lock_version` in
-- de RETURNING-clause van de INSERT. Postgres weigert te raden (42702).
--
-- Het idempotent-pad had géén last van deze bug omdat daar `d.lock_version`
-- expliciet gekwalificeerd is via de tabel-alias `d`. Bij een bestaand
-- project retourneerde de RPC dus correct — alleen de allereerste bootstrap
-- per org faalde.
--
-- Fix: kwalificeer de kolom in de RETURNING met de tabelnaam. Dat is de
-- minimale wijziging (geen change aan de signature, geen change aan
-- ondertekende invariants). Alle andere gedrag (advisory-lock, org/member/
-- role-checks, idempotency-pad, quota-observatie, chk_doc_shape defense-in-
-- depth) blijft byte-identiek aan 0011.
--
-- CREATE OR REPLACE FUNCTION is atomair vanaf de commit van deze migration
-- — geen intermediate window waarin de functie ontbreekt.

create or replace function public.create_project_and_document_internal(
  p_actor_user_id   uuid,
  p_org_id          uuid,
  p_name            text,
  p_document_type   text,
  p_seed_doc        jsonb,
  p_schema_version  text
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
  v_role       text;
  v_project_id uuid;
  v_doc_id     uuid;
  v_lock_ver   integer;
begin
  if p_actor_user_id is null then
    raise exception 'missing_actor_user_id' using errcode = '28000';
  end if;

  if p_document_type not in ('website','offerte','roadbook','brochure','social','document') then
    raise exception 'invalid_document_type' using errcode = '22023';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 200 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if p_schema_version is null or char_length(trim(p_schema_version)) = 0 then
    raise exception 'invalid_schema_version' using errcode = '22023';
  end if;
  if p_seed_doc is null or jsonb_typeof(p_seed_doc) <> 'object' then
    raise exception 'invalid_seed_doc' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('bootstrap:' || p_org_id::text));

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

  select p.id, d.id, d.lock_version
    into v_project_id, v_doc_id, v_lock_ver
    from public.projects p
    join public.project_documents d on d.project_id = p.id
    where p.organization_id = p_org_id
      and p.deleted_at is null
    order by p.created_at asc
    limit 1;

  if found then
    project_id          := v_project_id;
    project_document_id := v_doc_id;
    lock_version        := v_lock_ver;
    return next;
    return;
  end if;

  insert into public.projects
    (organization_id, name, description, document_type, created_by)
    values (p_org_id, p_name, null, p_document_type, p_actor_user_id)
    returning id into v_project_id;

  -- FIX vs 0011: tabelnaam-kwalificatie op `project_documents.lock_version`
  -- zodat de OUT-parameter `lock_version` (gedeclareerd via `returns table(...)`)
  -- de kolomnaam niet meer schaduwt.
  insert into public.project_documents
    (project_id, doc, schema_version, updated_by, lock_version)
    values (v_project_id, p_seed_doc, p_schema_version, p_actor_user_id, 1)
    returning
      public.project_documents.id,
      public.project_documents.lock_version
      into v_doc_id, v_lock_ver;

  project_id          := v_project_id;
  project_document_id := v_doc_id;
  lock_version        := v_lock_ver;
  return next;
end $$;

-- Owner + grants blijven zoals gezet door 0011 (CREATE OR REPLACE bewaart die),
-- maar we herbevestigen defensief voor het geval een handmatig-uitgevoerde
-- variant iets veranderd heeft.
alter function public.create_project_and_document_internal(uuid, uuid, text, text, jsonb, text)
  owner to postgres;
revoke execute on function public.create_project_and_document_internal(uuid, uuid, text, text, jsonb, text)
  from public, anon, authenticated;
grant  execute on function public.create_project_and_document_internal(uuid, uuid, text, text, jsonb, text)
  to service_role;

-- 0014_multi_document_per_project.sql
--
-- Multi-document per project. Zie [[project-multi-project-foundation]].
--
-- Migration 0002 (regel 154) definieerde `project_documents.project_id UNIQUE`
-- → één document per project. Voor multi-project + multi-document (website +
-- offerte + roadbook onder één project) moet die UNIQUE eraf.
--
-- Wijzigingen (allemaal additief/veilig; bestaande app blijft werken):
--   1. UNIQUE-constraint op project_documents.project_id → droppen +
--      non-unique index ter vervanging.
--   2. Nieuwe kolom `document_type` (NOT NULL, CHECK) — per-document type
--      dat mag afwijken van projects.document_type (de laatste blijft
--      bestaan als "primary type" van het project).
--   3. Nieuwe kolom `title` (NOT NULL, CHECK 1..200) — display-naam voor
--      het document binnen het project ("Home-pagina", "Offerte-versie-a").
--   4. Backfill van beide kolommen vanuit projects (document_type + name).
--   5. Bootstrap-RPC uit 0011 update'n om de nieuwe kolommen te vullen zodat
--      nieuwe project+doc-inserts NOT NULL respecteren.
--
-- Bestaande RPCs die naar project_documents SELECTeren OP project_id (bv.
-- save_document_internal in 0008) blijven werken zolang er maximaal 1 doc
-- per project bestaat — wat waar is op moment van deze migratie. Zodra
-- create_project_document (0016) meerdere docs per project mogelijk maakt,
-- moeten die RPCs upgraden naar document_id-key. Dat gebeurt in 0015 met
-- een NIEUWE save_document_v2_internal — geen breaking change aan 0008.

--------------------------------------------------------------------------------
-- Stap 1: nullable kolommen toevoegen + backfill
--------------------------------------------------------------------------------

alter table public.project_documents
  add column if not exists document_type text;

alter table public.project_documents
  add column if not exists title text;

update public.project_documents pd
  set document_type = coalesce(pd.document_type, p.document_type),
      title         = coalesce(pd.title, p.name)
  from public.projects p
  where p.id = pd.project_id;

--------------------------------------------------------------------------------
-- Stap 2: NOT NULL + CHECK-constraints
-- (Voor idempotency: probeer eerst DROP van constraints met identieke naam
-- zodat re-runs geen fout geven op "already exists".)
--------------------------------------------------------------------------------

alter table public.project_documents
  alter column document_type set not null;

alter table public.project_documents
  alter column title set not null;

alter table public.project_documents
  drop constraint if exists chk_pd_document_type;

alter table public.project_documents
  add constraint chk_pd_document_type
  check (document_type in ('website','offerte','roadbook','brochure','social','document'));

alter table public.project_documents
  drop constraint if exists chk_pd_title_length;

alter table public.project_documents
  add constraint chk_pd_title_length
  check (char_length(trim(title)) between 1 and 200);

--------------------------------------------------------------------------------
-- Stap 3: UNIQUE op project_id → non-unique index
--
-- LET OP: de constraint-naam kan zijn `project_documents_project_id_key`
-- (Postgres auto-naming voor inline UNIQUE bij CREATE TABLE) OF `uq_...`
-- als deze ooit expliciet was benoemd. Migration 0002 gebruikte inline
-- UNIQUE zonder explicit constraint-naam, dus de auto-name is verwacht.
--------------------------------------------------------------------------------

alter table public.project_documents
  drop constraint if exists project_documents_project_id_key;

-- Vervangende non-unique index. Behoudt read-performance van project→docs-lookup.
create index if not exists ix_docs_by_project
  on public.project_documents (project_id);

--------------------------------------------------------------------------------
-- Stap 4: bootstrap-RPC update'n zodat nieuwe INSERT's document_type + title
-- vullen. Signature blijft identiek; alleen de INSERT-clause verandert.
--------------------------------------------------------------------------------

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

  -- Idempotency: bestaand project → retourneer diens ALLEREERSTE doc.
  -- Na multi-doc kan er meerdere docs bestaan; bootstrap kiest de oudste
  -- (deterministisch), matcht de A2-tijd verwachting van "één-first-doc".
  select p.id, d.id, d.lock_version
    into v_project_id, v_doc_id, v_lock_ver
    from public.projects p
    join public.project_documents d on d.project_id = p.id
    where p.organization_id = p_org_id
      and p.deleted_at is null
    order by p.created_at asc, d.created_at asc
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

  -- Nu OOK document_type + title op de doc-rij zetten (nieuwe NOT NULL kolommen).
  insert into public.project_documents
    (project_id, doc, schema_version, updated_by, lock_version, document_type, title)
    values (v_project_id, p_seed_doc, p_schema_version, p_actor_user_id, 1, p_document_type, p_name)
    returning
      public.project_documents.id,
      public.project_documents.lock_version
      into v_doc_id, v_lock_ver;

  project_id          := v_project_id;
  project_document_id := v_doc_id;
  lock_version        := v_lock_ver;
  return next;
end $$;

alter function public.create_project_and_document_internal(uuid, uuid, text, text, jsonb, text)
  owner to postgres;
revoke execute on function public.create_project_and_document_internal(uuid, uuid, text, text, jsonb, text)
  from public, anon, authenticated;
grant  execute on function public.create_project_and_document_internal(uuid, uuid, text, text, jsonb, text)
  to service_role;

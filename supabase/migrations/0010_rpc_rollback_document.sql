-- 0010_rpc_rollback_document.sql
--
-- Voegt de `rollback_to_version`-RPC toe voor de toekomstige `rollback-document`
-- Edge Function (A3.3). De RPC is service_role-only en volgt exact dezelfde
-- canonieke lockketen als `save_document_internal` (0008):
--
--   organizations(share) → projects(share) → organization_members(update)
--                        → project_documents(update)
--
-- Contract-samenvatting:
--   - Actor-id (p_actor_user_id) komt uit de geverifieerde JWT van de Edge
--     Function; wordt NOOIT uit de request-body geaccepteerd.
--   - Rollback schrijft altijd een NIEUWE immutable version-rij met de
--     teruggezette inhoud; bestaande versions worden NOOIT gemuteerd (blijven
--     beschermd door reject_mutation-trigger uit 0003).
--   - `project_documents.lock_version` wordt met 1 verhoogd (optimistic-lock).
--   - Rol-eis: owner / admin / editor van de actieve organisatie.
--
-- Schema-versie-beleid (MVP):
--   Rollback is uitsluitend toegestaan als target_version.schema_version
--   EXACT gelijk is aan project_documents.schema_version. Zo verandert
--   rollback nooit de actieve schema-versie en kan de huidige applicatie
--   het teruggezette document lezen. `is distinct from` is null-veilig.
--   LET OP: deze SQL-controle bewijst uitsluitend gelijkheid van
--   schema_version-strings. Zij bewijst NIET dat de doc-inhoud tegen de
--   actuele TypeScript DesignDocSchema valide is; volledige inhoudsvalidatie
--   volgt later in de Edge-laag vóór de RPC-aanroep.
--
-- Foutmodel (SQLSTATE + machinecode-in-MESSAGE):
--   28000 missing_actor_user_id
--   22023 missing_expected_lock_version
--   42704 not_found                              -- parent-document niet gevonden
--   22023 organization_not_active
--   22023 project_not_active
--   42501 membership_not_active
--   42501 insufficient_role
--   55P03 lock_version_mismatch
--   42704 target_version_not_found
--   22023 target_schema_version_incompatible
--
-- Naam-ambiguïteit: de TABLE-return-kolommen krijgen bewust `new_`-prefixes
-- (new_lock_version, new_version_number) om shadowing van tabelnamen te
-- voorkomen. De laatste RETURN QUERY gebruikt literals uit lokale variabelen
-- zonder FROM-clause — geen kolom-resolutie ambigu.

create or replace function public.rollback_to_version(
  p_actor_user_id         uuid,
  p_project_document_id   uuid,
  p_target_version_number integer,
  p_expected_lock_version integer
) returns table (
  project_document_id  uuid,
  new_lock_version     integer,
  new_version_number   integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org_id            uuid;
  v_project_id        uuid;
  v_role              text;
  v_current_lock      integer;
  v_current_schema_ver text;
  v_target_doc        jsonb;
  v_target_schema_ver text;
  v_next_version      integer;
begin
  if p_actor_user_id is null then
    raise exception 'missing_actor_user_id' using errcode = '28000';
  end if;
  -- NULL-veilige guard: zonder deze check evalueert `v_current_lock <> NULL`
  -- naar NULL en zou de optimistic-lock silently worden omzeild.
  if p_expected_lock_version is null then
    raise exception 'missing_expected_lock_version' using errcode = '22023';
  end if;

  -- Stap 0: bepaal org+project zonder lock voor de canonieke lockketen
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
  -- na de lock stabiel is voor de rest van de transactie.
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

  -- Stap D: project_documents FOR UPDATE — optimistic-lock-check + huidige
  -- schema-versie ophalen (uit dezelfde locked rij).
  select lock_version, schema_version
    into v_current_lock, v_current_schema_ver
    from public.project_documents
    where id = p_project_document_id
    for update;
  if v_current_lock <> p_expected_lock_version then
    raise exception 'lock_version_mismatch'
      using errcode = '55P03', detail = 'current=' || v_current_lock::text;
  end if;

  -- Stap E: haal doel-version (immutable, beschermd door reject_mutation)
  -- Tabel-alias `v` noodzakelijk: zonder alias is `where project_document_id`
  -- ambigu met de TABLE-return-kolom van dezelfde naam.
  select v.doc, v.schema_version
    into v_target_doc, v_target_schema_ver
    from public.project_document_versions as v
    where v.project_document_id = p_project_document_id
      and v.version_number = p_target_version_number;
  if not found then
    raise exception 'target_version_not_found'
      using errcode = '42704', detail = 'target=' || p_target_version_number::text;
  end if;

  -- Stap E.5: schema-versie-beleid (MVP) — exact gelijk, null-veilig
  if v_target_schema_ver is distinct from v_current_schema_ver then
    raise exception 'target_schema_version_incompatible'
      using errcode = '22023',
            detail = 'current=' || coalesce(v_current_schema_ver, 'null')
                  || '; target=' || coalesce(v_target_schema_ver, 'null');
  end if;

  -- Stap F: bepaal nieuw versienummer voor de rollback-snapshot
  -- (zelfde alias-reden als Stap E)
  select coalesce(max(v.version_number), 0) + 1 into v_next_version
    from public.project_document_versions as v
    where v.project_document_id = p_project_document_id;

  -- Stap G: schrijf NIEUWE version-rij met teruggezette inhoud
  -- (historie compleet — géén delete van bestaande versions)
  insert into public.project_document_versions
    (project_document_id, version_number, doc, schema_version, author_id, author_note)
  values
    (p_project_document_id, v_next_version, v_target_doc, v_target_schema_ver,
     p_actor_user_id,
     'rollback to version ' || p_target_version_number::text);

  -- Stap H: overschrijf project_documents.doc met de teruggezette inhoud
  -- + bump lock_version. schema_version blijft ongewijzigd (Stap E.5 borgt
  -- dat target en current gelijk zijn, dus toewijzing is idempotent).
  update public.project_documents
    set doc            = v_target_doc,
        schema_version = v_target_schema_ver,
        updated_by     = p_actor_user_id,
        updated_at     = now(),
        lock_version   = lock_version + 1
    where id = p_project_document_id;

  -- Return via literal-values uit lokale variabelen: geen kolom-shadowing
  -- met de TABLE-return-kolommen.
  return query
    select p_project_document_id,
           (v_current_lock + 1)::integer,
           v_next_version;
end $$;
alter function public.rollback_to_version(uuid, uuid, integer, integer) owner to postgres;
revoke execute on function public.rollback_to_version(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant  execute on function public.rollback_to_version(uuid, uuid, integer, integer)
  to service_role;

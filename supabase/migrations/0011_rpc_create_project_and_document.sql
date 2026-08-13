-- 0011_rpc_create_project_and_document.sql
--
-- create_project_and_document_internal (service_role ONLY)
--
--   Bootstrap-RPC. Idempotent per organisatie: als er al een actief project
--   bestaat in p_org_id, retourneert de bestaande project + project_document
--   ongewijzigd (geen nieuwe rij, geen quota-verbruik, geen lock_version-bump).
--   Alleen als er 0 actieve projecten in de org zijn wordt er een nieuw
--   project + project_documents-rij aangemaakt met p_seed_doc.
--
--   Aangeroepen door de Edge Function `create-project-document` NA:
--     1. JWT-verificatie via Supabase Auth (getUser)
--     2. Zod-schema-validatie op p_seed_doc (DesignDoc-minimumshape)
--     3. Whitelist-check op p_document_type + name-lengte-check
--
--   p_actor_user_id komt uit de geverifieerde JWT — NOOIT uit de request-body.
--
--   Race-safety:
--     - pg_advisory_xact_lock('bootstrap:'||org_id) serialiseert twee concurrente
--       bootstrap-calls binnen dezelfde org (bv. twee tabbladen die tegelijk
--       openen na eerste login). Zonder deze lock kunnen beide voorbij de
--       "bestaat er al een project?"-check glippen en elk een eigen project
--       aanmaken.
--     - FOR SHARE op organizations blokkeert soft_delete_organization tijdens
--       de bootstrap.
--     - FOR UPDATE op organization_members serialiseert met remove_member /
--       change_member_role / leave_organization zodat rol- en membership-
--       status stabiel is voor de rest van de transactie.
--
--   Volledige lockketen:
--     advisory(bootstrap:org)
--       → organizations FOR SHARE
--         → organization_members FOR UPDATE
--           → (indien create) projects insert + project_documents insert
--
--   Quota-observatie: het bestaand-return-pad hierboven raakt geen quota
--   (er wordt niets aangemaakt). Het create-pad kan alleen bereikt worden
--   als er 0 actieve projecten in de org zijn — ver onder de 20-project
--   limiet van create_project — dus expliciete quota-check hier is overbodig.
--   Voor toekomstige "extra projecten aanmaken"-flows blijft public.create_project
--   het canonieke pad met eigen advisory-lock + quota-check.
--
--   Defense-in-depth: de bestaande CHECK-constraint chk_doc_shape op
--   project_documents.doc valideert de minimum-jsonb-vorm nogmaals bij INSERT.
--   Wanneer Zod in de Edge Function een malformed doc laat doorglippen (dev-bug),
--   raise't Postgres 23514 (check_violation) hier keihard — die mag NIET in de
--   allowlist van de Edge Function verschijnen zodat de client een generic 500
--   krijgt in plaats van een leaked shape-detail.

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

  -- Vroege whitelist-checks (defense-in-depth naast Zod in de Edge Function).
  -- Zelfde lijst als chk_document_type in 0002_schema.sql — houd in sync.
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

  -- Advisory lock: serialiseer twee tabbladen die tegelijk bootstrappen in
  -- dezelfde org. Zonder deze lock kunnen twee gelijktijdige calls beide
  -- door de "bestaat er al een project?"-check glippen en elk een eigen
  -- project aanmaken (dubbele startprojecten).
  perform pg_advisory_xact_lock(hashtext('bootstrap:' || p_org_id::text));

  -- Organisatie moet actief zijn (blokkeert concurrente soft_delete_organization).
  perform 1 from public.organizations
    where id = p_org_id and deleted_at is null for share;
  if not found then raise exception 'organization_not_active' using errcode = '22023'; end if;

  -- Membership + rol-check.
  -- FOR UPDATE serialiseert met remove_member / change_member_role /
  -- leave_organization, zodat rol- en membershipstatus stabiel is.
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

  -- Idempotency: bestaat er al een actief project in deze org?
  -- Zo ja → retourneer dat + zijn document ongewijzigd. Geen nieuwe insert,
  -- geen bump van lock_version. Twee tabbladen die na de advisory-lock hier
  -- aankomen zien allebei hetzelfde bestaande project.
  --
  -- Sorteervolgorde created_at ASC + LIMIT 1 → deterministisch. Als de org
  -- later meerdere projecten heeft (via public.create_project), pakt bootstrap
  -- het oudste. Dat is prima: bootstrap is bedoeld voor eerste-login, waar
  -- er per definitie nog geen andere projecten zijn.
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

  -- Geen actief project → maak een nieuw project + doc.
  insert into public.projects
    (organization_id, name, description, document_type, created_by)
    values (p_org_id, p_name, null, p_document_type, p_actor_user_id)
    returning id into v_project_id;

  insert into public.project_documents
    (project_id, doc, schema_version, updated_by, lock_version)
    values (v_project_id, p_seed_doc, p_schema_version, p_actor_user_id, 1)
    returning id, lock_version into v_doc_id, v_lock_ver;

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

-- 0002_schema.sql
-- Tabellen, indexes, constraints. Geen policies of grants — die komen in 0004.
-- Geen RPCs — die komen in 0005-0008.

-- Extensies (Supabase heeft deze meestal al beschikbaar in schema `extensions`)
create extension if not exists pgcrypto  with schema extensions;
create extension if not exists citext    with schema extensions;

-- Helper: search_path zodat digest()/gen_random_bytes() vindbaar zijn zonder alias
-- (functies zullen expliciet `extensions.digest(...)` gebruiken; deze regel is
-- alleen voor DDL-leesbaarheid).

--------------------------------------------------------------------------------
-- profiles
--------------------------------------------------------------------------------

create table if not exists public.profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  display_name        text,
  avatar_url          text,
  external_user_ref   text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists ix_profiles_external_user_ref
  on public.profiles (external_user_ref)
  where external_user_ref is not null;

--------------------------------------------------------------------------------
-- organizations
--------------------------------------------------------------------------------

create table if not exists public.organizations (
  id                  uuid primary key default extensions.gen_random_uuid(),
  slug                text not null,
  name                text not null,
  description         text,
  external_org_ref    text,
  created_by          uuid not null references public.profiles(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  -- LET OP: dezelfde slug-regex staat óók in public.create_organization() in
  -- 0005_rpc_org_and_project.sql voor snelle, leesbare RPC-fouten. Als je de
  -- vorm/lengte wijzigt hier, PAS DAN OOK DE RPC AAN (en 0009_auth_hooks als
  -- de personal-workspace-slug erdoor breekt).
  constraint chk_org_slug_shape check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$'),
  constraint chk_org_name_length check (char_length(trim(name)) between 1 and 80)
);

-- Slug uniek voor niet-verwijderde orgs (soft-delete geeft de slug vrij)
create unique index if not exists uq_active_org_slug
  on public.organizations (slug) where deleted_at is null;

create index if not exists ix_org_external_ref
  on public.organizations (external_org_ref)
  where external_org_ref is not null;

create index if not exists ix_org_active
  on public.organizations (id) where deleted_at is null;

--------------------------------------------------------------------------------
-- organization_members
--------------------------------------------------------------------------------

create table if not exists public.organization_members (
  id                  uuid primary key default extensions.gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  user_id             uuid not null references public.profiles(id) on delete cascade,
  role                text not null,
  invited_by          uuid references public.profiles(id) on delete restrict,
  invited_at          timestamptz,
  joined_at           timestamptz,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  constraint chk_member_role check (role in ('owner','admin','editor','viewer'))
);

-- Eén actieve membership per (org, user)
create unique index if not exists uq_active_org_member
  on public.organization_members (organization_id, user_id)
  where deleted_at is null;

create index if not exists ix_members_by_user_active
  on public.organization_members (user_id)
  where deleted_at is null;

create index if not exists ix_members_by_org_role
  on public.organization_members (organization_id, role)
  where deleted_at is null;

--------------------------------------------------------------------------------
-- organization_invitations
--------------------------------------------------------------------------------

create table if not exists public.organization_invitations (
  id                  uuid primary key default extensions.gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  email               extensions.citext not null,
  role                text not null,
  invited_by          uuid not null references public.profiles(id) on delete restrict,
  token_hash          bytea not null,
  expires_at          timestamptz not null default (now() + interval '14 days'),
  accepted_at         timestamptz,
  accepted_by         uuid references public.profiles(id) on delete set null,
  revoked_at          timestamptz,
  created_at          timestamptz not null default now(),
  -- Option A (definitief): geen owner-invitations
  constraint chk_invitation_role check (role in ('admin','editor','viewer'))
);

create unique index if not exists uq_invitation_token_hash
  on public.organization_invitations (token_hash);

-- Maximaal één openstaande uitnodiging per e-mail per org
create unique index if not exists uq_pending_invite_per_email
  on public.organization_invitations (organization_id, lower(email::text))
  where accepted_at is null and revoked_at is null;

--------------------------------------------------------------------------------
-- projects
--------------------------------------------------------------------------------

create table if not exists public.projects (
  id                  uuid primary key default extensions.gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  name                text not null,
  description         text,
  document_type       text not null,
  created_by          uuid not null references public.profiles(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  constraint chk_project_name_length check (char_length(trim(name)) between 1 and 200),
  constraint chk_document_type check (
    document_type in ('website','offerte','roadbook','brochure','social','document')
  )
);

create index if not exists ix_projects_by_org_active
  on public.projects (organization_id)
  where deleted_at is null;

create index if not exists ix_projects_by_creator
  on public.projects (created_by);

--------------------------------------------------------------------------------
-- project_documents
--------------------------------------------------------------------------------

create table if not exists public.project_documents (
  id                  uuid primary key default extensions.gen_random_uuid(),
  project_id          uuid not null unique references public.projects(id) on delete cascade,
  doc                 jsonb not null,
  schema_version      text not null,
  lock_version        integer not null default 1,
  updated_by          uuid not null references public.profiles(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Defense-in-depth: minimale shape-check op de doc-JSONB.
  -- Volledige Zod-validatie gebeurt in de Edge Function vóór save_document_internal.
  constraint chk_doc_shape check (
    jsonb_typeof(doc) = 'object'
    and doc ? 'version'
    and doc ? 'project'
    and doc ? 'pages'
    and jsonb_typeof(doc->'pages') = 'array'
    and jsonb_array_length(doc->'pages') >= 1
  ),
  constraint chk_lock_version_positive check (lock_version >= 1)
);

create index if not exists ix_docs_by_updated
  on public.project_documents (updated_at desc);

--------------------------------------------------------------------------------
-- project_document_versions
--------------------------------------------------------------------------------

create table if not exists public.project_document_versions (
  id                  uuid primary key default extensions.gen_random_uuid(),
  project_document_id uuid not null references public.project_documents(id) on delete cascade,
  version_number      integer not null,
  doc                 jsonb not null,
  schema_version      text not null,
  author_id           uuid not null references public.profiles(id) on delete restrict,
  author_note         text,
  created_at          timestamptz not null default now(),
  constraint chk_version_number_positive check (version_number >= 1),
  constraint chk_version_doc_shape check (jsonb_typeof(doc) = 'object')
);

create unique index if not exists uq_version_per_doc
  on public.project_document_versions (project_document_id, version_number);

create index if not exists ix_versions_by_doc_time
  on public.project_document_versions (project_document_id, created_at desc);

--------------------------------------------------------------------------------
-- document_data_snapshots
-- Alleen server-side gevuld (integratielaag). Immutable na creatie.
--------------------------------------------------------------------------------

create table if not exists public.document_data_snapshots (
  id                  uuid primary key default extensions.gen_random_uuid(),
  project_document_id uuid not null references public.project_documents(id) on delete restrict,
  binding_ref         text not null,
  provider            text not null,
  external_id         text not null,
  locale              text,
  currency            text,
  filter              jsonb,
  data                jsonb not null,
  provenance          jsonb not null,
  created_at          timestamptz not null default now(),
  constraint chk_snapshot_provider check (
    provider in ('travel-compositor','qenner','nextpax','studio4-internal')
  ),
  constraint chk_snapshot_data_shape check (jsonb_typeof(data) = 'object'),
  constraint chk_snapshot_provenance_shape check (
    jsonb_typeof(provenance) = 'object'
    and provenance ? 'fetched_at'
    and provenance ? 'integration_version'
  )
);

create index if not exists ix_snapshots_by_doc
  on public.document_data_snapshots (project_document_id, binding_ref);

--------------------------------------------------------------------------------
-- rate_limit_counters
--
-- Onder fase 2A is er nog maar ÉÉN echte rate-limited actie:
--   invite_member  → scope_id = organization_id  → 30 per uur per organisatie
--
-- create_organization en create_project zijn geen rate limits maar HARDE quota
-- (5 actieve memberships per user; 20 actieve projecten per org) — die worden
-- door de RPC's zelf gecheckt via directe count() + advisory lock.
--
-- Het scope_id-veld heeft geen FK omdat de betekenis per action verschilt.
-- Voor 'invite_member' is scope_id een organizations.id. Cleanup bij org-delete
-- gebeurt niet automatisch (windows verlopen binnen een uur, cleanup-cron later).
--------------------------------------------------------------------------------

create table if not exists public.rate_limit_counters (
  scope_id     uuid not null,
  action       text not null,
  window_start timestamptz not null,
  count        integer not null default 1,
  primary key (scope_id, action, window_start),
  constraint chk_ratelimit_action check (action in ('invite_member'))
);

create index if not exists ix_ratelimit_lookup
  on public.rate_limit_counters (scope_id, action, window_start desc);

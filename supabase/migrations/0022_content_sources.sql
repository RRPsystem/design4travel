-- =============================================================================
-- 0022_content_sources.sql
--
-- Generieke content-source-tabel. Elke bron (fixture / travel_compositor /
-- studio4_content / manual) landt hier als gesanitiseerd TravelContent-object.
-- Ontwerpen (design_templates) verwijzen ernaar via nullable FK.
--
-- Beveiliging:
--   - RLS strikt user-scoped: iedere user ziet alleen eigen sources.
--   - `content` mag GEEN API-keys of ruwe DB-primary-keys bevatten — dat wordt
--     server-side afgedwongen door de resolve-content-source Edge Function
--     (die Zod-parsed tegen TravelContentSchema uit @design4/travel-content
--     vóór insert).
--   - UNIQUE op (owner_user_id, kind, source_id, version) voorkomt dubbele
--     resolves; upsert-lookup gebruikt deze index.
-- =============================================================================

do $$ begin
  if not exists (select 1 from pg_type where typname = 'content_source_kind') then
    create type public.content_source_kind as enum (
      'fixture',
      'travel_compositor',
      'studio4_content',
      'manual'
    );
  end if;
end $$;

create table if not exists public.content_sources (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  kind public.content_source_kind not null,
  source_id text,
  version text,
  hash text check (hash is null or hash ~ '^[0-9a-f]{64}$'),
  content jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, kind, source_id, version)
);

create index if not exists content_sources_owner_created_idx
  on public.content_sources (owner_user_id, created_at desc);

alter table public.content_sources enable row level security;

drop policy if exists "content_sources_owner_select" on public.content_sources;
create policy "content_sources_owner_select"
  on public.content_sources
  for select
  to authenticated
  using (owner_user_id = auth.uid());

drop policy if exists "content_sources_owner_insert" on public.content_sources;
create policy "content_sources_owner_insert"
  on public.content_sources
  for insert
  to authenticated
  with check (owner_user_id = auth.uid());

drop policy if exists "content_sources_owner_update" on public.content_sources;
create policy "content_sources_owner_update"
  on public.content_sources
  for update
  to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

drop policy if exists "content_sources_owner_delete" on public.content_sources;
create policy "content_sources_owner_delete"
  on public.content_sources
  for delete
  to authenticated
  using (owner_user_id = auth.uid());

create or replace function public.tg_content_sources_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists content_sources_touch_updated_at on public.content_sources;
create trigger content_sources_touch_updated_at
  before update on public.content_sources
  for each row execute function public.tg_content_sources_touch_updated_at();

-- design_templates.content_source_id (nullable) — bindt een opgeslagen ontwerp
-- aan de exacte content-versie waarmee het gemaakt is. Nullable want
-- historische templates (vóór deze migratie) hebben géén binding.
alter table public.design_templates
  add column if not exists content_source_id uuid references public.content_sources(id) on delete set null;

create index if not exists design_templates_content_source_idx
  on public.design_templates (content_source_id)
  where content_source_id is not null;

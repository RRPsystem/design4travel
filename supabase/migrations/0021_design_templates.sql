-- =============================================================================
-- 0021_design_templates.sql
--
-- User-owned bibliotheek van goedgekeurde AI-ontwerpen. Nadat een reisagent
-- via chat een revise-flow heeft afgerond en tevreden is, kan die op
-- 'Opslaan als template' klikken; dat schrijft manifest + component-tsx +
-- reference-image-path naar deze tabel. Later (buiten scope van deze
-- migratie) kan een template-picker daar uit lezen.
--
-- RLS: strikt user-scoped. Geen kruisverkeer tussen users.
-- =============================================================================

create table if not exists public.design_templates (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  manifest jsonb not null,
  component_tsx text not null,
  reference_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, slug)
);

create index if not exists design_templates_owner_created_idx
  on public.design_templates (owner_user_id, created_at desc);

alter table public.design_templates enable row level security;

-- SELECT: alleen eigen rows
drop policy if exists "design_templates_owner_select" on public.design_templates;
create policy "design_templates_owner_select"
  on public.design_templates
  for select
  to authenticated
  using (owner_user_id = auth.uid());

-- INSERT: user zet owner_user_id op eigen uid
drop policy if exists "design_templates_owner_insert" on public.design_templates;
create policy "design_templates_owner_insert"
  on public.design_templates
  for insert
  to authenticated
  with check (owner_user_id = auth.uid());

-- UPDATE: alleen eigen rows, owner_user_id blijft eigen uid
drop policy if exists "design_templates_owner_update" on public.design_templates;
create policy "design_templates_owner_update"
  on public.design_templates
  for update
  to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

-- DELETE: alleen eigen rows
drop policy if exists "design_templates_owner_delete" on public.design_templates;
create policy "design_templates_owner_delete"
  on public.design_templates
  for delete
  to authenticated
  using (owner_user_id = auth.uid());

-- updated_at trigger
create or replace function public.tg_design_templates_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists design_templates_touch_updated_at on public.design_templates;
create trigger design_templates_touch_updated_at
  before update on public.design_templates
  for each row execute function public.tg_design_templates_touch_updated_at();

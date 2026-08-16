-- =============================================================================
-- 0018_sandbox_runs.sql
--
-- Tabel voor rate-limiting en ownership-tracking van E2B sandbox-runs die door
-- de sandbox-build-trigger Edge Function worden gestart. Zonder deze tabel kan
-- een ingelogde user onbeperkt sandboxes aanroepen (E2B Hobby: 20 concurrent),
-- en kan user A theoretisch expose/destroy doen op user B's sandbox_id.
--
-- Ownership: sandbox_id moet gekoppeld zijn aan de user die 'prepare' aanriep.
-- Rate-limits (afgedwongen server-side, niet in SQL): max 5 concurrent sandboxes
-- per user, max 30 sandboxes per user per uur.
--
-- RLS: users mogen alleen hun eigen rijen zien; INSERT/UPDATE via service-role
-- (Edge Function). Fail-open logging past bij het bestaande `ai_call_metrics`
-- patroon (migratie 0013).
-- =============================================================================

create table if not exists public.sandbox_runs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  org_id         uuid,                              -- optional; sluit aan op bestaande org-scoping
  sandbox_id     text not null,                     -- E2B sandbox_id
  provider       text not null default 'e2b',       -- toekomstig: fly-io etc.
  status         text not null default 'active'
                 check (status in ('active','destroyed','failed')),
  purpose        text,                              -- 'engine-a-preview' / 'engine-b-render' etc.
  created_at     timestamptz not null default now(),
  last_phase_at  timestamptz not null default now(),
  destroyed_at   timestamptz,
  meta           jsonb not null default '{}'::jsonb
);

create unique index if not exists sandbox_runs_sandbox_id_uniq
  on public.sandbox_runs (sandbox_id);

create index if not exists sandbox_runs_user_status_idx
  on public.sandbox_runs (user_id, status);

create index if not exists sandbox_runs_user_created_idx
  on public.sandbox_runs (user_id, created_at desc);

alter table public.sandbox_runs enable row level security;

-- Users zien alleen hun eigen runs
create policy sandbox_runs_select_own
  on public.sandbox_runs
  for select
  using (auth.uid() = user_id);

-- Geen INSERT/UPDATE/DELETE vanuit user-context; alleen service-role
-- (Edge Function met SUPABASE_SERVICE_ROLE_KEY schrijft namens de user).
revoke insert, update, delete on public.sandbox_runs from anon, authenticated;

comment on table public.sandbox_runs is
  'Tracking van E2B sandbox-runs voor rate-limiting + ownership-check op sandbox-build-trigger Edge Function. RLS: users zien alleen eigen rows; alleen service-role muteert.';

comment on column public.sandbox_runs.status is
  '`active` = sandbox draait nog (of moet nog gekilld); `destroyed` = clean shutdown; `failed` = pipeline-error, mogelijk nog een levende E2B-sandbox tot 30min-timeout';

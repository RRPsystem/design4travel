-- 0013_ai_call_metrics.sql
--
-- ai_call_metrics — één rij per Anthropic-API-call vanuit een van onze
-- Edge Functions. Geen prompts / geen responses / geen API-keys — alleen de
-- metadata die nodig is voor cost-aggregation + billing.
--
-- Waarom deze data nu al vastleggen (zonder billing-UI): de business is
-- prepaid credits (user koopt bv. €10 tegoed). Een toekomstige credit_wallet
-- + credit_ledger-tabel kan pas correct opgebouwd worden als we vanaf dag 1
-- weten wat elke call gekost heeft. Zonder deze tabel wordt billing later
-- een grote refactor.
--
-- Delegation model (per project_anthropic_api_conventions):
--   Sonnet-orchestrator → mogelijk delegate_to_opus → Opus-specialist.
--   Beide calls delen `parent_call_id` (=id van de router-call). Zo kunnen
--   twee (of meer) rows tot één gebruikersopdracht worden opgeteld voor
--   billing en dashboards.
--
-- Wat we bewust NIET opslaan:
--   - Prompt-tekst        (privacy + storage)
--   - Response-tekst      (idem)
--   - JWT / access token  (security)
--   - Anthropic API key   (security)
--   - Doc-inhoud          (staat al in project_documents; hier zou het
--                          een dubbele copy zijn met bovendien een leak-risk)
--
-- Fail-open beleid (in de Edge Function, niet in SQL):
--   Een mislukte insert in deze tabel mag NOOIT de AI-response blokkeren.
--   De Edge Function catch't de insert-fout, logt naar console.error, en
--   levert de AI-response alsnog aan de client. Metrics zijn observability,
--   niet correctheid.

--------------------------------------------------------------------------------
-- Table
--------------------------------------------------------------------------------

create table if not exists public.ai_call_metrics (
  id                      uuid primary key default extensions.gen_random_uuid(),
  user_id                 uuid not null references public.profiles(id) on delete cascade,
  organization_id         uuid not null references public.organizations(id) on delete cascade,

  -- Provider identiteit (nu alleen 'anthropic', maar voorbereid op meerdere).
  provider                text not null default 'anthropic',
  model                   text not null,

  -- Router / specialist / standalone.
  --   router     — de sonnet-call die evt. delegate_to_opus emitteerde
  --   specialist — de opus-call gestart door de router-delegatie
  --   standalone — een enkele call zonder router (bv. toekomstige direct-opus-flow)
  kind                    text not null,

  -- Groepering: als deze row een specialist-call is, wijst parent_call_id
  -- naar de router-call. Voor router en standalone: null. Self-FK, geen
  -- cascade — als een router-row ooit wordt verwijderd, houden we de
  -- specialist-row met een dangling pointer (we verwijderen deze rijen
  -- nooit uit product-oogpunt, maar we blokkeren delete niet hard).
  parent_call_id          uuid references public.ai_call_metrics(id) on delete set null,

  -- Waarom de router delegate'de (of niet). Vrije tekst zoals door het model
  -- aangeleverd via de rationale-arg van delegate_to_opus, gecapped op 500
  -- chars om runaway te voorkomen.
  route_reason            text,

  -- Uitkomst
  success                 boolean not null,
  error_code              text,             -- bv. 'anthropic_429', 'invalid_tool_use'
  request_id              text,             -- Anthropic's response-header 'request-id' voor cross-ref

  -- Token usage — allemaal >= 0 (0 als het veld niet aanwezig is in de response).
  input_tokens            integer not null default 0,
  output_tokens           integer not null default 0,
  cache_read_tokens       integer not null default 0,
  cache_creation_tokens   integer not null default 0,
  thinking_tokens         integer not null default 0,

  latency_ms              integer not null default 0,

  -- Kosten in microUSD (10⁻⁶ USD). Nullable: de Edge Function kan een pricing-
  -- versie-string opslaan zonder onmiddellijk de kosten uit te rekenen; een
  -- latere batch-job of view kan de kosten reconstrueren uit tokens ×
  -- pricing_version-tarief.
  provider_cost_microusd  bigint,
  pricing_version         text not null,    -- bv. 'anthropic-2026-08' of iets granulairs

  created_at              timestamptz not null default now(),

  constraint chk_kind check (kind in ('router','specialist','standalone')),
  constraint chk_route_reason_length check (route_reason is null or char_length(route_reason) <= 500),
  constraint chk_error_code_length check (error_code is null or char_length(error_code) between 1 and 100),
  constraint chk_request_id_length check (request_id is null or char_length(request_id) between 1 and 200),
  constraint chk_model_length check (char_length(model) between 1 and 100),
  constraint chk_provider_length check (char_length(provider) between 1 and 40),
  constraint chk_pricing_version_length check (char_length(pricing_version) between 1 and 40),
  constraint chk_tokens_nonneg check (
    input_tokens >= 0 and output_tokens >= 0
    and cache_read_tokens >= 0 and cache_creation_tokens >= 0
    and thinking_tokens >= 0
  ),
  constraint chk_latency_nonneg check (latency_ms >= 0),
  constraint chk_cost_nonneg check (provider_cost_microusd is null or provider_cost_microusd >= 0),
  -- Specialist-rijen moeten een parent hebben; router/standalone niet.
  constraint chk_parent_matches_kind check (
    (kind = 'specialist' and parent_call_id is not null)
    or (kind in ('router','standalone') and parent_call_id is null)
  )
);

--------------------------------------------------------------------------------
-- Indexes
--------------------------------------------------------------------------------

-- Owner/admin dashboard-queries per organisatie op tijd.
create index if not exists ix_ai_metrics_by_org_time
  on public.ai_call_metrics (organization_id, created_at desc);

-- User-eigen usage-view op tijd.
create index if not exists ix_ai_metrics_by_user_time
  on public.ai_call_metrics (user_id, created_at desc);

-- Voor het optellen van router+specialist tot één gebruikersopdracht.
create index if not exists ix_ai_metrics_by_parent
  on public.ai_call_metrics (parent_call_id) where parent_call_id is not null;

--------------------------------------------------------------------------------
-- RLS
--------------------------------------------------------------------------------

alter table public.ai_call_metrics enable row level security;
alter table public.ai_call_metrics force  row level security;

-- User ziet eigen calls; owner/admin ziet ALLE calls binnen de eigen org.
-- Editor + viewer zien alleen eigen calls (geen inzage in andermans usage).
create policy p_ai_metrics_select_own_or_org_admin
  on public.ai_call_metrics for select
  using (
    user_id = auth.uid()
    or public.active_org_role(organization_id) in ('owner','admin')
  );

-- Alleen SELECT voor authenticated. Geen INSERT/UPDATE/DELETE — writes
-- gebeuren via service_role in de Edge Function.
grant select on public.ai_call_metrics to authenticated;

-- Immutability: geen UPDATE / DELETE — ook niet door service_role uit
-- gebruikers-gedreven paden. Als er OOIT een correctie nodig is (pricing-
-- fout, GDPR-verzoek), gebeurt dat via een handmatige admin-actie buiten
-- de Edge Function om. Voor v1 blokkeren we het compleet via triggers.
create or replace function public.ai_metrics_block_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'ai_call_metrics is immutable' using errcode = '2F002';
end $$;
alter function public.ai_metrics_block_update() owner to postgres;

drop trigger if exists tg_ai_metrics_no_update on public.ai_call_metrics;
create trigger tg_ai_metrics_no_update
  before update on public.ai_call_metrics
  for each row execute function public.ai_metrics_block_update();

drop trigger if exists tg_ai_metrics_no_delete on public.ai_call_metrics;
create trigger tg_ai_metrics_no_delete
  before delete on public.ai_call_metrics
  for each row execute function public.ai_metrics_block_update();

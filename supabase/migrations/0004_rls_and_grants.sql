-- 0004_rls_and_grants.sql
-- RLS enable/force per tabel + SELECT-policies + per-tabel expliciete
-- kolom-scoped grants aan `authenticated`. Alle mutaties lopen via RPCs
-- (0005-0008). `anon` krijgt niks.

--------------------------------------------------------------------------------
-- profiles
--------------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.profiles force  row level security;

-- User ziet eigen profiel + profielen van andere leden in gedeelde organisaties
create policy p_profiles_self_or_shared_read on public.profiles for select
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.organization_members m_self
      join public.organization_members m_other
        on m_self.organization_id = m_other.organization_id
      join public.organizations o on o.id = m_self.organization_id
      where m_self.user_id  = auth.uid()
        and m_other.user_id = public.profiles.id
        and m_self.deleted_at is null and m_self.joined_at is not null
        and m_other.deleted_at is null and m_other.joined_at is not null
        and o.deleted_at is null
    )
  );

create policy p_profiles_self_update on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

grant select on public.profiles to authenticated;
-- updated_at zit NIET in de whitelist: de tg_profiles_updated_at-trigger
-- (0003) overschrijft de waarde altijd BEFORE UPDATE. Een client-grant erop
-- zou alleen verwarrend zijn.
grant update (display_name, avatar_url) on public.profiles to authenticated;
-- Geen INSERT/DELETE — profile ontstaat via auth-trigger, verdwijnt via cascade

--------------------------------------------------------------------------------
-- organizations
--------------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.organizations force  row level security;

create policy p_org_select on public.organizations for select
  using (public.is_active_org_member(id));

create policy p_org_update on public.organizations for update
  using (public.active_org_role(id) in ('owner','admin'))
  with check (public.active_org_role(id) in ('owner','admin'));

grant select on public.organizations to authenticated;
-- updated_at zit NIET in de whitelist (trigger overschrijft; zie profiles).
grant update (name, slug, description) on public.organizations to authenticated;
-- Geen INSERT/DELETE — via RPCs
-- created_by, deleted_at, external_org_ref: geen kolom-grant → immutable via RPC

--------------------------------------------------------------------------------
-- organization_members
--------------------------------------------------------------------------------

alter table public.organization_members enable row level security;
alter table public.organization_members force  row level security;

create policy p_mem_select on public.organization_members for select
  using (public.is_active_org_member(organization_id));

grant select on public.organization_members to authenticated;
-- Geen INSERT/UPDATE/DELETE — via smalle RPCs (0006)

--------------------------------------------------------------------------------
-- organization_invitations
--------------------------------------------------------------------------------

alter table public.organization_invitations enable row level security;
alter table public.organization_invitations force  row level security;

-- Alleen leden van de org zien uitnodigingen; user ziet ook eigen inkomende
-- uitnodigingen op basis van e-mail (voor "mijn uitnodigingen"-scherm).
--
-- E-mail komt uit de JWT-claims (`auth.jwt() ->> 'email'`), NIET uit auth.users
-- direct: `authenticated` heeft geen SELECT-grant op auth.users (getest in T30),
-- dus een subquery daar veroorzaakt permission_denied en breekt de policy.
-- Ontbrekende email-claim geeft géén toegang (`is not null`-guard).
create policy p_invitation_select on public.organization_invitations for select
  using (
    public.is_active_org_member(organization_id)
    or (
      auth.jwt() ->> 'email' is not null
      and lower(email::text) = lower(auth.jwt() ->> 'email')
    )
  );

-- Beperk kolom-SELECT: token_hash wordt NOOIT geëxposeerd
grant select (id, organization_id, email, role, invited_by,
              expires_at, accepted_at, accepted_by, revoked_at, created_at)
      on public.organization_invitations to authenticated;
-- Geen INSERT/UPDATE/DELETE — via invite_member / accept_invitation / revoke_invitation

--------------------------------------------------------------------------------
-- projects
--------------------------------------------------------------------------------

alter table public.projects enable row level security;
alter table public.projects force  row level security;

create policy p_proj_select on public.projects for select
  using (
    public.is_active_org_member(organization_id)
    and deleted_at is null
  );

create policy p_proj_update on public.projects for update
  using (
    public.active_org_role(organization_id) in ('owner','admin','editor')
    and deleted_at is null
  )
  with check (
    public.active_org_role(organization_id) in ('owner','admin','editor')
  );

grant select on public.projects to authenticated;
-- updated_at zit NIET in de whitelist (trigger overschrijft; zie profiles).
grant update (name, description, document_type)
      on public.projects to authenticated;
-- organization_id, created_by, deleted_at: geen kolom-grant → immutable via RPC
-- Geen INSERT/DELETE — via RPCs

--------------------------------------------------------------------------------
-- project_documents
--------------------------------------------------------------------------------

alter table public.project_documents enable row level security;
alter table public.project_documents force  row level security;

create policy p_doc_select on public.project_documents for select
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_documents.project_id
        and public.is_active_org_member(p.organization_id)
        and p.deleted_at is null
    )
  );

grant select on public.project_documents to authenticated;
-- Alle writes via save_document_internal (service_role only) — 0008

--------------------------------------------------------------------------------
-- project_document_versions
--------------------------------------------------------------------------------

alter table public.project_document_versions enable row level security;
alter table public.project_document_versions force  row level security;

create policy p_ver_select on public.project_document_versions for select
  using (
    exists (
      select 1
      from public.project_documents d
      join public.projects p on p.id = d.project_id
      where d.id = project_document_versions.project_document_id
        and public.is_active_org_member(p.organization_id)
        and p.deleted_at is null
    )
  );

grant select on public.project_document_versions to authenticated;
-- Immutability via triggers in 0003. INSERT via create_document_snapshot-RPC.

--------------------------------------------------------------------------------
-- document_data_snapshots
--------------------------------------------------------------------------------

alter table public.document_data_snapshots enable row level security;
alter table public.document_data_snapshots force  row level security;

create policy p_data_snapshot_select on public.document_data_snapshots for select
  using (
    exists (
      select 1
      from public.project_documents d
      join public.projects p on p.id = d.project_id
      where d.id = document_data_snapshots.project_document_id
        and public.is_active_org_member(p.organization_id)
        and p.deleted_at is null
    )
  );

grant select on public.document_data_snapshots to authenticated;
-- Writes uitsluitend server-side (service_role) via integratielaag (2B+).

--------------------------------------------------------------------------------
-- rate_limit_counters
--------------------------------------------------------------------------------

alter table public.rate_limit_counters enable row level security;
alter table public.rate_limit_counters force  row level security;

-- Geen enkele policy → geen enkele client-toegang. Alleen RPCs (SECURITY DEFINER).
-- Geen grants.

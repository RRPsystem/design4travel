-- 0007_rpc_invitations.sql
--
-- Lockvolgorde voor invitation-mutaties:
--   organizations → organization_invitations → organization_members
--
-- Invitations bevatten per CHECK-constraint (0002) geen owner-rol, dus
-- FOR SHARE op organizations volstaat — owner-serialisatie is niet nodig.
--
-- Rate limit: 30 uitnodigingen per uur PER ORGANISATIE
-- (rate_limit_counters.scope_id = organization_id, action = 'invite_member').
--
-- Membership-quota (max 5 actieve per user) wordt in accept_invitation
-- gecontroleerd op de accepterende user, met advisory lock op die user.
--
-- Tokens: klartext wordt ALLEEN geretourneerd door invite_member (éénmalig).
-- DB slaat uitsluitend SHA-256-hash op.

--------------------------------------------------------------------------------
-- invite_member  → retourneert het klartext-token (base64url) éénmalig
--------------------------------------------------------------------------------

create or replace function public.invite_member(
  p_org_id uuid,
  p_email  text,
  p_role   text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_uid        uuid := auth.uid();
  v_actor_role text;
  v_token      text;
  v_hash       bytea;
  v_window     timestamptz := date_trunc('hour', now());
  v_count      integer;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  -- Stap A: FOR SHARE op organizations
  perform 1 from public.organizations
    where id = p_org_id and deleted_at is null for share;
  if not found then raise exception 'organization_not_active' using errcode = '22023'; end if;

  -- active_org_role() geeft NULL voor non-members; expliciete null-guard nodig
  -- (NULL not in (...) = NULL, en `if NULL then` = false).
  v_actor_role := public.active_org_role(p_org_id);
  if v_actor_role is null or v_actor_role not in ('owner','admin') then
    raise exception 'insufficient_role' using errcode = '42501';
  end if;
  if p_role not in ('admin','editor','viewer') then
    raise exception 'invalid_role_for_invite' using errcode = '22023';
  end if;
  -- Email-validatie:
  --   - basisvorm `<local>@<domain>.<tld>` met minstens één punt in het domein
  --   - lengte 3..320 (RFC 5321)
  --   - géén whitespace of controlekaraters
  -- De Edge Function `invite-mailer` (blok A3) doet aanvullend validatie op
  -- deliverability + MX. Hier laten we in ieder geval een duidelijke
  -- applicatiefout raisen en niet pas terugvallen op de unique-index van
  -- uq_pending_invite_per_email met een generieke 23505.
  if p_email is null
     or char_length(p_email) not between 3 and 320
     or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.organization_invitations
    where organization_id = p_org_id
      and lower(email::text) = lower(p_email)
      and accepted_at is null
      and revoked_at  is null
  ) then
    raise exception 'invitation_already_pending' using errcode = '23505';
  end if;

  -- Rate limit: 30 uitnodigingen/uur PER ORGANISATIE
  insert into public.rate_limit_counters (scope_id, action, window_start, count)
    values (p_org_id, 'invite_member', v_window, 1)
    on conflict (scope_id, action, window_start)
    do update set count = public.rate_limit_counters.count + 1
    returning count into v_count;
  if v_count > 30 then
    raise exception 'rate_limit_exceeded' using errcode = '53400';
  end if;

  -- Genereer URL-safe base64 token (base64url zonder padding).
  -- `translate('+/=', '-_')`: '+' → '-', '/' → '_', '=' → verwijderd
  -- (source-string is 3 chars, target 2 chars, dus '=' valt weg).
  v_token := translate(
              encode(extensions.gen_random_bytes(32), 'base64'),
              '+/=', '-_'
             );
  v_hash  := extensions.digest(v_token, 'sha256');

  insert into public.organization_invitations
    (organization_id, email, role, invited_by, token_hash)
    values (p_org_id, p_email, p_role, v_uid, v_hash);

  return v_token;
end $$;
alter function public.invite_member(uuid, text, text) owner to postgres;
revoke execute on function public.invite_member(uuid, text, text) from public, anon;
grant  execute on function public.invite_member(uuid, text, text) to authenticated;

--------------------------------------------------------------------------------
-- accept_invitation
--   Canonieke lockvolgorde: organizations → organization_invitations → organization_members
--------------------------------------------------------------------------------

create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_uid        uuid := auth.uid();
  v_email      text;
  v_hash       bytea;
  v_inv_id     uuid;
  v_inv_org_id uuid;
  v_inv        record;
  v_existing   record;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select email into v_email from auth.users where id = v_uid;
  if v_email is null or char_length(v_email) = 0 then
    -- Kan alleen als de user in auth.users zonder e-mail is aangemaakt
    -- (bv. via OAuth die geen mail-scope geeft). Zonder e-mail is er geen
    -- betekenisvolle match met de invitation-email mogelijk.
    raise exception 'missing_user_email' using errcode = '28000';
  end if;
  v_hash := extensions.digest(p_token, 'sha256');

  -- Stap A: prefilter zonder lock om organization_id te bepalen
  select id, organization_id into v_inv_id, v_inv_org_id
    from public.organization_invitations
    where token_hash = v_hash;
  if not found then
    raise exception 'invitation_invalid_expired_or_email_mismatch' using errcode = '22023';
  end if;

  -- Stap B: FOR SHARE op organizations (blokkeert soft_delete_organization)
  perform 1 from public.organizations
    where id = v_inv_org_id and deleted_at is null for share;
  if not found then
    raise exception 'organization_not_active_at_acceptance' using errcode = '22023';
  end if;

  -- Stap C: FOR UPDATE op invitations; alle condities opnieuw
  select * into v_inv
    from public.organization_invitations
    where id = v_inv_id
      and token_hash = v_hash
      and organization_id = v_inv_org_id
      and accepted_at is null
      and revoked_at  is null
      and expires_at  > now()
      and lower(email::text) = lower(v_email)
      and role in ('admin','editor','viewer')
    for update;
  if not found then
    raise exception 'invitation_invalid_expired_or_email_mismatch' using errcode = '22023';
  end if;

  -- Stap D: FOR UPDATE op eventueel bestaand membership (elke status)
  select * into v_existing
    from public.organization_members
    where organization_id = v_inv.organization_id and user_id = v_uid
    for update;

  if found then
    if v_existing.deleted_at is null and v_existing.joined_at is not null then
      update public.organization_invitations
        set accepted_at = now(), accepted_by = v_uid
        where id = v_inv.id;
      return v_inv.organization_id;
    else
      -- Geen silent restore; owner moet expliciet via restore_member() ingrijpen
      raise exception 'previous_membership_needs_manual_restore'
        using errcode = '42501',
              detail = 'existing_id=' || v_existing.id::text;
    end if;
  end if;

  -- Fresh-insert: quota-check onder advisory lock op deze user
  perform pg_advisory_xact_lock(hashtext('membership_set:' || v_uid::text));
  if public.active_membership_count(v_uid) >= 5 then
    raise exception 'membership_quota_exceeded'
      using errcode = '23514',
            detail = 'active_memberships=' || public.active_membership_count(v_uid)::text;
  end if;

  insert into public.organization_members
    (organization_id, user_id, role, invited_by, joined_at)
    values (v_inv.organization_id, v_uid, v_inv.role, v_inv.invited_by, now());

  update public.organization_invitations
    set accepted_at = now(), accepted_by = v_uid
    where id = v_inv.id;

  return v_inv.organization_id;
end $$;
alter function public.accept_invitation(text) owner to postgres;
revoke execute on function public.accept_invitation(text) from public, anon;
grant  execute on function public.accept_invitation(text) to authenticated;

--------------------------------------------------------------------------------
-- revoke_invitation  (idempotent)
--------------------------------------------------------------------------------

create or replace function public.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_uid    uuid := auth.uid();
  v_org_id uuid;
  v_role   text;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  select organization_id into v_org_id
    from public.organization_invitations where id = p_invitation_id;
  if not found then raise exception 'not_found' using errcode = '42704'; end if;

  perform 1 from public.organizations
    where id = v_org_id and deleted_at is null for share;
  if not found then raise exception 'organization_not_active' using errcode = '22023'; end if;

  -- active_org_role() null-guard (zie soft_delete_organization).
  v_role := public.active_org_role(v_org_id);
  if v_role is null or v_role not in ('owner','admin') then
    raise exception 'insufficient_role' using errcode = '42501';
  end if;

  update public.organization_invitations
    set revoked_at = now()
    where id = p_invitation_id
      and accepted_at is null
      and revoked_at is null;
  -- 0 rows affected → invitation was reeds geaccepteerd/ingetrokken; geen error
end $$;
alter function public.revoke_invitation(uuid) owner to postgres;
revoke execute on function public.revoke_invitation(uuid) from public, anon;
grant  execute on function public.revoke_invitation(uuid) to authenticated;

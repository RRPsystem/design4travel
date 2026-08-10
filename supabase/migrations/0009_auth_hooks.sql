-- 0009_auth_hooks.sql
--
-- Bij nieuwe auth.users-insert:
--   1. Maak profile-rij aan
--   2. Maak "Personal" organization aan (fresh insert; NOOIT bestaand claimen)
--   3. Voeg user toe als owner van eigen personal org (fresh insert; NOOIT bestaand claimen)
--
-- Alles atomair via SECURITY DEFINER (draait als postgres, bypasst tabel-REVOKE).
-- De personal-org krijgt een deterministische slug 'p-<32hex UUID>'.
--
-- FAIL-CLOSED: de trigger draait binnen de auth.users-insert-transactie. Als
-- een van de inserts hieronder faalt, rolt de héle signup terug. Dat is
-- bewust: liever een tijdelijke signup-fout dan een user zonder profile/
-- personal-workspace, én liever niet-signup dan STILZWIJGEND een bestaande
-- organizations-slug (aangemaakt door iemand anders) of een bestaand
-- organization_members-record overnemen.
--
-- Concreet:
--   - Slug `p-<uuid>` is 34 chars — past in chk_org_slug_shape (1..40).
--   - Slug-collision met een user-created org is theoretisch mogelijk als
--     iemand handmatig 'p-<32hex>' aanvraagt in create_organization. De
--     unique-index `uq_active_org_slug` raise dan hier `unique_violation`
--     en rolt signup terug. Dit is de gewenste uitkomst (fail-closed).
--   - `organization_members` heeft géén on-conflict-clause: als voor deze
--     (org, user)-combinatie al een membership bestaat, moet de trigger
--     falen in plaats van dat lidmaatschap stilzwijgend te herbevestigen.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_display  text;
  v_org_id   uuid;
  v_slug     text;
begin
  v_display := split_part(coalesce(new.email, 'user'), '@', 1);

  -- 1. Profile — on-conflict do nothing is veilig: profiles.id is 1:1 met
  --    auth.users.id (FK cascade), dus een conflict betekent dat een eerdere
  --    trigger-run voor dezelfde user het profile al aanmaakte. Geen data-verlies.
  insert into public.profiles (id, display_name)
    values (new.id, v_display)
    on conflict (id) do nothing;

  -- 2. Personal organization — fresh insert (géén on-conflict-clause).
  --    Collision => unique_violation => signup-transactie rolt terug (fail-closed).
  v_slug := 'p-' || replace(new.id::text, '-', '');

  insert into public.organizations (name, slug, description, created_by)
    values ('Personal — ' || v_display, v_slug, 'Persoonlijke workspace', new.id)
    returning id into v_org_id;

  -- 3. Owner-membership — fresh insert (géén on-conflict-clause).
  --    Collision op uq_active_org_member => unique_violation => rollback.
  insert into public.organization_members
    (organization_id, user_id, role, invited_by, joined_at)
    values (v_org_id, new.id, 'owner', new.id, now());

  return new;
end $$;
alter function public.handle_new_auth_user() owner to postgres;
-- Defense-in-depth: trigger-only functie (draait via tg_on_auth_user_created);
-- geen client-role hoort deze rechtstreeks aan te roepen.
revoke execute on function public.handle_new_auth_user() from public;

-- De trigger draait NA insert op auth.users. auth.users behoort tot supabase-auth,
-- dus we hebben CREATE TRIGGER-recht daar (Supabase staat dit toe).
drop trigger if exists tg_on_auth_user_created on auth.users;
create trigger tg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

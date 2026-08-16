-- =============================================================================
-- 0019_design_references_bucket_policies.sql
--
-- RLS-policies voor de `design-references` Storage bucket. Zonder deze
-- policies faalt authenticated INSERT met "new row violates row-level
-- security policy".
--
-- Iteratie 4c.1-scope: alle ingelogde gebruikers mogen uploaden + lezen +
-- verwijderen in deze bucket. Voor productie later verscherpen tot
-- user-scoped paden (bijv. `<user_id>/<uuid>-<filename>` + policy die
-- `auth.uid()::text = split_part(name, '/', 1)` afdwingt).
--
-- LEES: Edge Function `generate-studio4-component` genereert een SHORT-lived
-- signed download URL voor Claude vision; die maakt deze policy voor SELECT
-- niet strikt noodzakelijk (service-role omzeilt RLS). Maar met SELECT
-- toestaan kan de user zelf zijn uploads inspecteren in het dashboard.
-- =============================================================================

-- Idempotent: verwijder eventuele oudere versies met dezelfde naam.
drop policy if exists design_references_insert_authenticated on storage.objects;
drop policy if exists design_references_select_authenticated on storage.objects;
drop policy if exists design_references_delete_authenticated on storage.objects;

create policy design_references_insert_authenticated
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'design-references');

create policy design_references_select_authenticated
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'design-references');

create policy design_references_delete_authenticated
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'design-references');

comment on policy design_references_insert_authenticated on storage.objects is
  'Design4 preview-host generate-mode: authenticated users mogen reference-images uploaden. Later verscherpen tot user-scoped paden.';

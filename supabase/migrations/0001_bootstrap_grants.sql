-- 0001_bootstrap_grants.sql
--
-- Doel: veeg alle default-privileges op de `public`-scope, zodat vervolgens
-- alleen expliciet toegekende rechten actief zijn.
--
-- Reden: Supabase geeft `authenticated` en `anon` standaard brede grants op
-- `public` bij projectcreatie. Als we die niet intrekken, kunnen kolom-scoped
-- REVOKE-statements later teniet worden gedaan door doorlopende table-wide
-- GRANTs. Zie het definitieve ontwerp §1 (kolomrechten).
--
-- Werkt idempotent: als een grant al ontbreekt is REVOKE een no-op.

-- Bestaande privileges op bestaande objecten
revoke all on all tables    in schema public from authenticated, anon;
revoke all on all sequences in schema public from authenticated, anon;
revoke all on all functions in schema public from authenticated, anon, public;

-- Toekomstige objecten (default privileges) — zorgt dat nieuwe tabellen/functies
-- die deze migration-stack later toevoegt ook niet automatisch toegankelijk zijn.
alter default privileges in schema public
  revoke all on tables    from authenticated, anon;
alter default privileges in schema public
  revoke all on sequences from authenticated, anon;
alter default privileges in schema public
  revoke all on functions from authenticated, anon, public;

-- USAGE op de public-schema zelf blijft nodig zodat clients überhaupt objecten
-- kunnen zien (SELECT-policy's doen daarna het echte filteren). Supabase kent
-- USAGE by default toe — expliciet bevestigen voor duidelijkheid.
grant usage on schema public to authenticated;
-- anon krijgt geen USAGE — anonieme toegang is voor fase 2A niet toegestaan
-- (magic-link-signup vereist authenticated-role).
revoke usage on schema public from anon;

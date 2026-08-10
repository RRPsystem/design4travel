-- 00_setup.sql
-- Test-shared setup wordt door supabase/seed.sql geladen (persisteert door alle
-- test-transacties). Dit bestand is nu leeg-op-één-check-na: we bevestigen dat
-- pgtap en de tests-helper aanwezig zijn.

begin;
set local search_path = extensions, public;

select plan(2);

select has_extension('pgtap', 'pgtap is beschikbaar in de test-DB');
select has_function('tests', 'sign_in_as', array['uuid'], 'tests.sign_in_as bestaat (via seed.sql)');

select * from finish();
rollback;

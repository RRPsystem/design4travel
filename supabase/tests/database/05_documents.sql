-- 05_documents.sql
-- C16, C17, C18 (slice), C19 (slice), C23, C24, C27, C29, C31, T22, T24, T44

begin;
set local search_path = extensions, public;

select plan(8);

insert into auth.users (id, instance_id, email, encrypted_password,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role, email_confirmed_at, created_at, updated_at)
values ('a1010101-1010-1010-1010-101010101010',
        '00000000-0000-0000-0000-000000000000',
        'a@doc.local','','{}'::jsonb,'{}'::jsonb,'authenticated','authenticated',
        now(), now(), now());

select tests.sign_in_as('a1010101-1010-1010-1010-101010101010');
select create_organization('Doc Team', 'doc-team');
select create_project(
  (select id from public.organizations where slug = 'doc-team'),
  'Doc project', 'website', null
);

-- Doc-rij via postgres (echte doc-flow loopt via EF; hier direct)
set role postgres;
insert into public.project_documents (project_id, doc, schema_version, updated_by)
select
  p.id,
  jsonb_build_object(
    'version','0.1.0',
    'project', jsonb_build_object('documentType','website','title','Test'),
    'pages',   jsonb_build_array(
      jsonb_build_object(
        'id','p1',
        'root', jsonb_build_object('id','r','type','layout-column','props','{}'::jsonb)
      )
    )
  ),
  '0.1.0',
  'a1010101-1010-1010-1010-101010101010'
from public.projects p where p.name = 'Doc project';
reset role;

--------------------------------------------------------------------------------
-- C16/C23: authenticated kan save_document_internal NIET aanroepen
--------------------------------------------------------------------------------
select tests.sign_in_as('a1010101-1010-1010-1010-101010101010');
select throws_ok(
  format($fmt$
    select save_document_internal(
      %L::uuid,
      (select id from public.projects where name = 'Doc project'),
      '{"version":"0.1.0","project":{"documentType":"website","title":"x"},"pages":[{"id":"p","root":{"id":"r","type":"text","props":{}}}]}'::jsonb,
      '0.1.0', 1)
  $fmt$, 'a1010101-1010-1010-1010-101010101010'),
  '42501',
  null,
  'C16/C23: authenticated cannot call save_document_internal directly'
);

--------------------------------------------------------------------------------
-- C17/C24: anon kan het ook niet
--------------------------------------------------------------------------------
select tests.sign_out();
set role anon;
select throws_ok(
  $$ select save_document_internal(
       '00000000-0000-0000-0000-000000000000'::uuid,
       '00000000-0000-0000-0000-000000000000'::uuid,
       '{}'::jsonb, '0.1.0', 1) $$,
  '42501',
  null,
  'C17/C24: anon cannot call save_document_internal directly'
);
reset role;

--------------------------------------------------------------------------------
-- T44/C18: service_role-call zonder JWT heeft auth.uid() = null
--          save_document_internal met NULL actor faalt keihard
--------------------------------------------------------------------------------
set role service_role;
select throws_ok(
  $$ select save_document_internal(
       null::uuid,
       '00000000-0000-0000-0000-000000000000'::uuid,
       '{"version":"0.1.0","project":{"documentType":"website","title":"x"},"pages":[{"id":"p","root":{"id":"r","type":"text","props":{}}}]}'::jsonb,
       '0.1.0', 1) $$,
  '28000',
  null,
  'T44/C18: save_document_internal with null actor_user_id raises not_authenticated'
);
reset role;

--------------------------------------------------------------------------------
-- Positieve save via service_role (simuleert EF)
--------------------------------------------------------------------------------
set role service_role;
select is(
  save_document_internal(
    'a1010101-1010-1010-1010-101010101010'::uuid,
    (select id from public.projects where name = 'Doc project'),
    jsonb_build_object(
      'version','0.1.0',
      'project', jsonb_build_object('documentType','website','title','Updated'),
      'pages',   jsonb_build_array(
        jsonb_build_object('id','p1','root',
          jsonb_build_object('id','r','type','layout-column','props','{}'::jsonb)))
    ),
    '0.1.0',
    1  -- expected lock version
  ),
  2,
  'save via service_role returns new lock_version = 2'
);
-- Volgende save met verkeerde lock_version faalt
select throws_ok(
  format($fmt$
    select save_document_internal(
      %L::uuid,
      (select id from public.projects where name = 'Doc project'),
      '{"version":"0.1.0","project":{"documentType":"website","title":"y"},"pages":[{"id":"p","root":{"id":"r","type":"text","props":{}}}]}'::jsonb,
      '0.1.0',
      1)  -- stale
  $fmt$, 'a1010101-1010-1010-1010-101010101010'),
  '55P03',
  null,
  'stale lock_version raises lock_version_mismatch'
);
reset role;

--------------------------------------------------------------------------------
-- T24: Postgres CHECK vangt corrupte doc af (defense in depth)
--------------------------------------------------------------------------------
set role postgres;
select throws_ok(
  $$ insert into public.project_documents (project_id, doc, schema_version, updated_by)
       values ('11111111-1111-1111-1111-111111111111'::uuid,
               '{"nope": true}'::jsonb, '0.1.0',
               'a1010101-1010-1010-1010-101010101010'::uuid) $$,
  '23514',   -- check_violation
  null,
  'T24: corrupt doc (missing version/project/pages) rejected by CHECK'
);
reset role;

--------------------------------------------------------------------------------
-- T22/C19: schema_version-mismatch (client vs DB) faalt fatsoenlijk
--          (Deze check hoort in de Edge Function; hier bewijzen we alleen dat
--           een doc met schema_version > current niet magisch geldiger wordt.)
--------------------------------------------------------------------------------
-- Skip: schema-versie-check is EF-verantwoordelijkheid, niet DB.
-- We markeren dit als een pending test via skip():
select skip('T22 lives in Edge Function tests (documents/rollback flow), not pgTAP', 1);

--------------------------------------------------------------------------------
-- Immutability van project_document_versions
--------------------------------------------------------------------------------
-- Maak een snapshot via de RPC en probeer 'm daarna te muteren
select tests.sign_in_as('a1010101-1010-1010-1010-101010101010');
select create_document_snapshot(
  (select id from public.project_documents
    where project_id = (select id from public.projects where name = 'Doc project')),
  'test snapshot'
);

set role postgres;
select throws_ok(
  $$ update public.project_document_versions set author_note = 'hacked' $$,
  '42501',
  null,
  'project_document_versions rows are immutable (reject_mutation trigger)'
);
reset role;

select * from finish();
rollback;

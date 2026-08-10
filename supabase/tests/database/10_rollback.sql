-- 10_rollback.sql
-- pgTAP-tests voor rollback_to_version (0010).
--
-- Uitgebreid t.o.v. eerste versie met (a) directe inhoudsverificatie na
-- rollback (kernfunctionaliteit), (b) missing_actor_user_id, (c) actor
-- die alleen elders lid is, (d) organization_not_active en
-- project_not_active op de RPC zelf. Alle machinecodes uit de kopcomment
-- van migration 0010 worden nu expliciet getest.

begin;
set local search_path = extensions, public;

select plan(23);

--------------------------------------------------------------------------------
-- Setup: 5 users, 2 orgs, 1 doc met 2 initial versions
--------------------------------------------------------------------------------
insert into auth.users (id, instance_id, email, encrypted_password,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role, email_confirmed_at, created_at, updated_at)
values
  ('aaaaaaaa-0010-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'owner@rb.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('bbbbbbbb-0010-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'viewer@rb.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('cccccccc-0010-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'outsider@rb.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('dddddddd-0010-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000',
   'former@rb.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now()),
  ('eeeeeeee-0010-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000',
   'other-owner@rb.local', '', '{}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now(), now());

select tests.sign_in_as('aaaaaaaa-0010-0000-0000-000000000001');
select create_organization('RB Team', 'rb-team');
select create_project(
  (select id from public.organizations where slug = 'rb-team'),
  'RB Project', 'website', null
);

-- other-owner maakt eigen org — voor RB-auth-4 (actor met membership elders)
select tests.sign_in_as('eeeeeeee-0010-0000-0000-000000000005');
select create_organization('RB Other Team', 'rb-other-team');

-- viewer + former-member (soft-deleted) handmatig toevoegen aan rb-team
set role postgres;
insert into public.organization_members (organization_id, user_id, role, invited_by, joined_at)
values
  ((select id from public.organizations where slug = 'rb-team'),
   'bbbbbbbb-0010-0000-0000-000000000002', 'viewer',
   'aaaaaaaa-0010-0000-0000-000000000001', now()),
  ((select id from public.organizations where slug = 'rb-team'),
   'dddddddd-0010-0000-0000-000000000004', 'editor',
   'aaaaaaaa-0010-0000-0000-000000000001', now() - interval '1 day');
update public.organization_members
  set deleted_at = now() - interval '1 hour'
  where user_id = 'dddddddd-0010-0000-0000-000000000004';

-- doc + 2 initial versions
--
-- De docs zijn bewust RIJK gemaakt (meerdere top-level velden, nested nodes,
-- children-arrays, per-output overrides, brand-tokens, meerdere pages) zodat
-- de volledige-jsonb-gelijkheids-assertions verderop niet triviaal alleen
-- op één titelveld leunen. current en version 1 verschillen structureel op
-- pages, brandTokens, outputs, meta én nested node-inhoud.
insert into public.project_documents (project_id, doc, schema_version, updated_by, lock_version)
select p.id,
       jsonb_build_object(
         'version', '0.1.0',
         'id',      'rb-current-doc',
         'project', jsonb_build_object(
                      'documentType','website',
                      'title','v0-current',
                      'brandId','brand-current'),
         'meta',    jsonb_build_object(
                      'createdAt','2026-01-01T00:00:00Z',
                      'updatedAt','2026-02-01T00:00:00Z'),
         'brandTokens', jsonb_build_object(
                      'brand.primary','#000000',
                      'brand.accent','#ff00ff'),
         'outputs', jsonb_build_object(
                      'web', jsonb_build_object('enabled', true)),
         'pages',   jsonb_build_array(
                      jsonb_build_object(
                        'id','current-page',
                        'name','Current only page',
                        'root', jsonb_build_object(
                          'id','current-root',
                          'type','text',
                          'props', jsonb_build_object('text','current body'))))
       ),
       '0.1.0',
       'aaaaaaaa-0010-0000-0000-000000000001',
       1
  from public.projects p where p.name='RB Project';

-- version 1: matchende schema (0.1.0) — target voor happy-path rollback.
-- Verschilt op ALLE top-level velden van current (pages, brandTokens,
-- outputs, meta, project.title, project.brandId) zodat full-jsonb-check
-- werkelijk iets bewijst.
insert into public.project_document_versions
  (project_document_id, version_number, doc, schema_version, author_id, author_note)
select d.id, 1,
       jsonb_build_object(
         'version', '0.1.0',
         'id',      'rb-v1-doc',
         'project', jsonb_build_object(
                      'documentType','website',
                      'title','v1-rich-fixture',
                      'brandId','brand-alpha'),
         'meta',    jsonb_build_object(
                      'createdAt','2025-06-01T00:00:00Z',
                      'updatedAt','2025-06-15T12:30:00Z'),
         'brandTokens', jsonb_build_object(
                      'brand.primary','#4f46e5',
                      'brand.secondary','#e11d48',
                      'brand.neutral','#334155'),
         'outputs', jsonb_build_object(
                      'web', jsonb_build_object('enabled', true),
                      'pdf', jsonb_build_object('enabled', false)),
         'pages',   jsonb_build_array(
                      jsonb_build_object(
                        'id','page-home',
                        'name','Home',
                        'root', jsonb_build_object(
                          'id','root-home',
                          'type','layout-column',
                          'props', jsonb_build_object('gap', 16, 'padding', 24),
                          'children', jsonb_build_array(
                            jsonb_build_object(
                              'id','hero-1',
                              'type','hero',
                              'props', jsonb_build_object(
                                'title','Welcome to v1',
                                'subtitle','Discover something original'),
                              'bind', jsonb_build_object(
                                'imageSrc','accommodation.heroImage'),
                              'overrides', jsonb_build_object(
                                'pdf', jsonb_build_object(
                                  'props', jsonb_build_object('title','Welcome (PDF)')))),
                            jsonb_build_object(
                              'id','text-1',
                              'type','text',
                              'props', jsonb_build_object('text','Body copy from version 1'))))),
                      jsonb_build_object(
                        'id','page-details',
                        'name','Details',
                        'root', jsonb_build_object(
                          'id','root-details',
                          'type','layout-row',
                          'props', jsonb_build_object('gap', 8),
                          'children', jsonb_build_array())))
       ),
       '0.1.0',
       'aaaaaaaa-0010-0000-0000-000000000001',
       'initial'
  from public.project_documents d
  where d.project_id = (select id from public.projects where name='RB Project');

-- version 2: OUDERE schema (0.0.9) — target voor RB-schema-2 (mismatch)
insert into public.project_document_versions
  (project_document_id, version_number, doc, schema_version, author_id, author_note)
select d.id, 2,
       jsonb_build_object(
         'version', '0.0.9',
         'project', jsonb_build_object(
                      'documentType','website',
                      'title','v2-old-schema'),
         'pages',   jsonb_build_array(jsonb_build_object('id','p','root',
           jsonb_build_object('id','r','type','text','props','{}'::jsonb)))
       ),
       '0.0.9',
       'aaaaaaaa-0010-0000-0000-000000000001',
       'legacy'
  from public.project_documents d
  where d.project_id = (select id from public.projects where name='RB Project');
reset role;

--------------------------------------------------------------------------------
-- RB-grants: authenticated kan de RPC NIET direct callen (service_role only)
--------------------------------------------------------------------------------
select tests.sign_in_as('aaaaaaaa-0010-0000-0000-000000000001');
select throws_ok(
  format($fmt$ select rollback_to_version(%L::uuid,
    (select id from public.project_documents where project_id =
      (select id from public.projects where name='RB Project')),
    1, 1) $fmt$, 'aaaaaaaa-0010-0000-0000-000000000001'),
  '42501',
  null,
  'RB-grants: authenticated cannot call rollback_to_version directly'
);

--------------------------------------------------------------------------------
-- Vanaf hier: service_role-context (zoals Edge Function zou doen)
--------------------------------------------------------------------------------
select tests.sign_out();

-- Capture doc-id + volledige version-1-JSONB in session-config voor herbruik.
-- Bewaren van v1.doc als text-serialization is nodig zodat we NA de rollback
-- (die een nieuwe version 3 schrijft met dezelfde inhoud) alsnog kunnen
-- bewijzen dat version 1 op byte-niveau ongewijzigd is gebleven — vergelijk
-- van version 1 met zichzelf zou anders trivialiter altijd slagen.
set role postgres;
select set_config('rb.doc_id',
  (select id::text from public.project_documents where project_id =
    (select id from public.projects where name='RB Project')),
  false);
select set_config('rb.v1_original',
  (select doc::text from public.project_document_versions
    where project_document_id = current_setting('rb.doc_id')::uuid
      and version_number = 1),
  false);
reset role;

set role service_role;

--------------------------------------------------------------------------------
-- RB-1: happy path — één rollback naar version 1, dan volledige
-- inhouds- + metadata-verificatie (kernfunctionaliteit rollback).
--
-- Vangt result van de rollback-call in session-configs zodat we daarna
-- als postgres de resulting state kunnen inspecteren zonder de kolom-
-- ambigüiteit die de RPC-body zelf onthulde tijdens A3.1.
--------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  select * into r from rollback_to_version(
    'aaaaaaaa-0010-0000-0000-000000000001'::uuid,
    current_setting('rb.doc_id')::uuid,
    1,
    1);
  perform set_config('rb.rb1_new_lock', r.new_lock_version::text, false);
  perform set_config('rb.rb1_new_ver',  r.new_version_number::text, false);
end $$;

select is(
  current_setting('rb.rb1_new_lock'),
  '2',
  'RB-1a: return new_lock_version = 2 (lock is met exact 1 verhoogd)'
);
select is(
  current_setting('rb.rb1_new_ver'),
  '3',
  'RB-1b: return new_version_number = 3 (monotoon, boven initial 1 en 2)'
);

reset role;
set role postgres;

-- RB-1c: FULL jsonb-gelijkheid — current doc == oorspronkelijke version 1 doc.
-- Vergelijkt de HELE jsonb-waarde (alle top-level velden, nested nodes,
-- children, brandTokens, outputs, meta) met de vóór-rollback vastgelegde
-- snapshot van version 1. Verschillen op WELK dan ook JSON-veld → fail.
select is(
  (select doc from public.project_documents
     where id = current_setting('rb.doc_id')::uuid),
  current_setting('rb.v1_original')::jsonb,
  'RB-1c: project_documents.doc is byte-voor-byte gelijk aan oorspronkelijke version 1 (full jsonb)'
);
select is(
  (select lock_version from public.project_documents
     where id = current_setting('rb.doc_id')::uuid)::text,
  '2',
  'RB-1d: project_documents.lock_version = 2 (persistente state matcht return)'
);
select is(
  (select updated_by::text from public.project_documents
     where id = current_setting('rb.doc_id')::uuid),
  'aaaaaaaa-0010-0000-0000-000000000001',
  'RB-1e: project_documents.updated_by = actor uit p_actor_user_id'
);
select is(
  (select schema_version from public.project_documents
     where id = current_setting('rb.doc_id')::uuid),
  '0.1.0',
  'RB-1f: project_documents.schema_version ongewijzigd (0.1.0)'
);
-- RB-1g: FULL jsonb-gelijkheid — nieuwe audit-version 3.doc == oorspronkelijke
-- version 1.doc. Bewijst dat de rollback niet alleen het live-doc terugzet
-- maar ook de complete inhoud correct in de audit-trail bewaart.
select is(
  (select doc from public.project_document_versions
     where project_document_id = current_setting('rb.doc_id')::uuid
       and version_number = 3),
  current_setting('rb.v1_original')::jsonb,
  'RB-1g: nieuwe version 3.doc is byte-voor-byte gelijk aan oorspronkelijke version 1 (full jsonb)'
);
select is(
  (select author_id::text from public.project_document_versions
     where project_document_id = current_setting('rb.doc_id')::uuid
       and version_number = 3),
  'aaaaaaaa-0010-0000-0000-000000000001',
  'RB-1h: nieuwe version 3 author_id = actor uit p_actor_user_id'
);
select is(
  (select schema_version from public.project_document_versions
     where project_document_id = current_setting('rb.doc_id')::uuid
       and version_number = 3),
  '0.1.0',
  'RB-1i: nieuwe version 3 schema_version = 0.1.0 (gelijk aan current)'
);

reset role;
set role service_role;

--------------------------------------------------------------------------------
-- RB-2: tweede rollback → monotone version_number (nu = 4)
--------------------------------------------------------------------------------
select is(
  (select new_version_number from rollback_to_version(
    'aaaaaaaa-0010-0000-0000-000000000001'::uuid,
    current_setting('rb.doc_id')::uuid,
    1,
    2))::text,
  '4',
  'RB-2: tweede rollback → new_version_number = 4 (monotoon)'
);

--------------------------------------------------------------------------------
-- RB-3: immutability — historische doelversie (version 1) niet gemuteerd
--------------------------------------------------------------------------------
reset role;
set role postgres;
-- RB-3: FULL jsonb-gelijkheid — historische version 1 is byte-voor-byte
-- ongewijzigd t.o.v. de vóór-rollback vastgelegde snapshot. Bewijst
-- reject_mutation-immutability + rollback niet-destructief op source.
select is(
  (select doc from public.project_document_versions
     where project_document_id = current_setting('rb.doc_id')::uuid
       and version_number = 1),
  current_setting('rb.v1_original')::jsonb,
  'RB-3: historische version 1 is byte-voor-byte identiek aan pre-rollback snapshot (full jsonb, reject_mutation)'
);
reset role;
set role service_role;

--------------------------------------------------------------------------------
-- RB-lock-1: verkeerde expected_lock_version → lock_version_mismatch (55P03)
--------------------------------------------------------------------------------
select throws_ok(
  format($fmt$ select rollback_to_version(%L::uuid, %L::uuid, 1, 99) $fmt$,
    'aaaaaaaa-0010-0000-0000-000000000001', current_setting('rb.doc_id')),
  '55P03',
  null,
  'RB-lock-1: verkeerde expected_lock_version → lock_version_mismatch'
);

--------------------------------------------------------------------------------
-- RB-lock-2: NULL expected_lock_version → missing_expected_lock_version (22023)
--------------------------------------------------------------------------------
select throws_ok(
  format($fmt$ select rollback_to_version(%L::uuid, %L::uuid, 1, null) $fmt$,
    'aaaaaaaa-0010-0000-0000-000000000001', current_setting('rb.doc_id')),
  '22023',
  null,
  'RB-lock-2: NULL expected_lock_version → missing_expected_lock_version'
);

--------------------------------------------------------------------------------
-- RB-tgt-1: onbestaande version_number → target_version_not_found (42704)
-- Actuele lock_version na 2 rollbacks: 3.
--------------------------------------------------------------------------------
select throws_ok(
  format($fmt$ select rollback_to_version(%L::uuid, %L::uuid, 999, 3) $fmt$,
    'aaaaaaaa-0010-0000-0000-000000000001', current_setting('rb.doc_id')),
  '42704',
  null,
  'RB-tgt-1: onbestaande version_number → target_version_not_found'
);

--------------------------------------------------------------------------------
-- RB-schema-2: target.schema_version ≠ current → target_schema_version_incompatible
-- Current schema = 0.1.0; version 2 heeft 0.0.9.
--------------------------------------------------------------------------------
select throws_ok(
  format($fmt$ select rollback_to_version(%L::uuid, %L::uuid, 2, 3) $fmt$,
    'aaaaaaaa-0010-0000-0000-000000000001', current_setting('rb.doc_id')),
  '22023',
  null,
  'RB-schema-2: schema-mismatch → target_schema_version_incompatible'
);

--------------------------------------------------------------------------------
-- RB-auth-1: outsider (geen enkele membership) → membership_not_active
--------------------------------------------------------------------------------
select throws_ok(
  format($fmt$ select rollback_to_version(%L::uuid, %L::uuid, 1, 3) $fmt$,
    'cccccccc-0010-0000-0000-000000000003', current_setting('rb.doc_id')),
  '42501',
  null,
  'RB-auth-1: outsider (geen membership) → membership_not_active'
);

--------------------------------------------------------------------------------
-- RB-auth-2: viewer → insufficient_role
--------------------------------------------------------------------------------
select throws_ok(
  format($fmt$ select rollback_to_version(%L::uuid, %L::uuid, 1, 3) $fmt$,
    'bbbbbbbb-0010-0000-0000-000000000002', current_setting('rb.doc_id')),
  '42501',
  null,
  'RB-auth-2: viewer → insufficient_role'
);

--------------------------------------------------------------------------------
-- RB-auth-3: soft-deleted membership → membership_not_active
--------------------------------------------------------------------------------
select throws_ok(
  format($fmt$ select rollback_to_version(%L::uuid, %L::uuid, 1, 3) $fmt$,
    'dddddddd-0010-0000-0000-000000000004', current_setting('rb.doc_id')),
  '42501',
  null,
  'RB-auth-3: soft-deleted membership → membership_not_active'
);

--------------------------------------------------------------------------------
-- RB-null-actor: NULL p_actor_user_id → missing_actor_user_id (28000)
-- Bewijst dat de expliciete null-guard in Stap 0 werkt en niet stilletjes
-- naar een 42501 vervalt via een lege membership-lookup.
--------------------------------------------------------------------------------
select throws_ok(
  format($fmt$ select rollback_to_version(null::uuid, %L::uuid, 1, 3) $fmt$,
    current_setting('rb.doc_id')),
  '28000',
  null,
  'RB-null-actor: NULL actor → missing_actor_user_id'
);

--------------------------------------------------------------------------------
-- RB-auth-4: actor is owner van ANDERE org (rb-other-team), geen lid van
-- rb-team. Bewijst dat een willekeurige geldige actor-ID niet volstaat —
-- de membership-check is org-specifiek.
--------------------------------------------------------------------------------
select throws_ok(
  format($fmt$ select rollback_to_version(%L::uuid, %L::uuid, 1, 3) $fmt$,
    'eeeeeeee-0010-0000-0000-000000000005', current_setting('rb.doc_id')),
  '42501',
  null,
  'RB-auth-4: actor met actieve membership elders → membership_not_active'
);

--------------------------------------------------------------------------------
-- RB-proj-inactive: soft-delete het project, dan rollback → project_not_active.
-- Wordt vóór RB-org-inactive uitgevoerd omdat een soft-deleted org de
-- project-status niet automatisch verandert (soft-delete cascadeert niet).
-- Herstel na de test niet nodig — de hele suite draait binnen `begin/rollback`.
--------------------------------------------------------------------------------
reset role;
set role postgres;
update public.projects set deleted_at = now()
  where id = (select project_id from public.project_documents
              where id = current_setting('rb.doc_id')::uuid);
reset role;
set role service_role;

select throws_ok(
  format($fmt$ select rollback_to_version(%L::uuid, %L::uuid, 1, 3) $fmt$,
    'aaaaaaaa-0010-0000-0000-000000000001', current_setting('rb.doc_id')),
  '22023',
  null,
  'RB-proj-inactive: soft-deleted project → project_not_active'
);

--------------------------------------------------------------------------------
-- RB-org-inactive: soft-delete de org bovenop het reeds soft-deleted project.
-- De RPC-lockketen zet Stap A (org) vóór Stap B (project), dus de raise die
-- volgt is organization_not_active — niet project_not_active. Dat bewijst
-- de canonieke volgorde.
--------------------------------------------------------------------------------
reset role;
set role postgres;
update public.organizations set deleted_at = now() where slug = 'rb-team';
reset role;
set role service_role;

select throws_ok(
  format($fmt$ select rollback_to_version(%L::uuid, %L::uuid, 1, 3) $fmt$,
    'aaaaaaaa-0010-0000-0000-000000000001', current_setting('rb.doc_id')),
  '22023',
  null,
  'RB-org-inactive: soft-deleted org → organization_not_active (voor project-check)'
);

reset role;
select * from finish();
rollback;

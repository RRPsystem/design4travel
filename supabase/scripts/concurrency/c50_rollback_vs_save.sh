#!/usr/bin/env bash
# C50 — rollback_to_version vs save_document_internal op hetzelfde doc.
# Beide RPCs nemen dezelfde canonieke lockketen (org→project→member→doc) én
# beide bumpen doc.lock_version. Ze serialiseren op member(U) + doc(U); één
# wint met de expected_lock_version-check, ander krijgt lock_version_mismatch.

set -euo pipefail
DBURL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"

psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/_seed.sql" >/dev/null

OWNER='11111111-0000-0000-0000-000000000001'
ORG=$(psql "$DBURL" -tAc "select id from public.organizations where slug='race-team'")

# Project + doc + één version seeden
psql "$DBURL" -v ON_ERROR_STOP=1 -q <<SQL >/dev/null
select set_config('request.jwt.claims',
  '{"sub":"$OWNER","role":"authenticated"}', false);
select set_config('role','authenticated', false);
select public.create_project('$ORG', 'C50 project', 'website', null);
SET ROLE postgres;
insert into public.project_documents (project_id, doc, schema_version, updated_by)
select p.id,
       jsonb_build_object(
         'version','0.1.0',
         'project', jsonb_build_object('documentType','website','title','initial'),
         'pages',   jsonb_build_array(jsonb_build_object('id','p','root',jsonb_build_object('id','r','type','text','props','{}'::jsonb)))
       ),
       '0.1.0',
       '$OWNER'
  from public.projects p where p.name='C50 project';
-- version 1 met matchende schema_version
insert into public.project_document_versions
  (project_document_id, version_number, doc, schema_version, author_id, author_note)
select d.id, 1,
       jsonb_build_object(
         'version','0.1.0',
         'project', jsonb_build_object('documentType','website','title','v1-target'),
         'pages',   jsonb_build_array(jsonb_build_object('id','p','root',jsonb_build_object('id','r','type','text','props','{}'::jsonb)))
       ),
       '0.1.0',
       '$OWNER',
       'seed'
  from public.project_documents d
  where d.project_id = (select id from public.projects where name='C50 project');
RESET ROLE;
SQL

PROJECT=$(psql "$DBURL" -tAc "select id from public.projects where name='C50 project'")
DOC=$(psql "$DBURL" -tAc "select id from public.project_documents where project_id='$PROJECT'")

tmp1=$(mktemp); tmp2=$(mktemp)
(
  # rollback als service_role
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    SET ROLE service_role;
    select public.rollback_to_version('$OWNER'::uuid, '$DOC'::uuid, 1, 1);
    RESET ROLE;
    commit;
  " >"$tmp1" 2>&1
) &
p1=$!
(
  # save als service_role
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    SET ROLE service_role;
    select public.save_document_internal(
      '$OWNER'::uuid,
      '$PROJECT'::uuid,
      '{\"version\":\"0.1.0\",\"project\":{\"documentType\":\"website\",\"title\":\"c50-save\"},\"pages\":[{\"id\":\"p\",\"root\":{\"id\":\"r\",\"type\":\"text\",\"props\":{}}}]}'::jsonb,
      '0.1.0', 1);
    RESET ROLE;
    commit;
  " >"$tmp2" 2>&1
) &
p2=$!
set +e; wait $p1; r1=$?; wait $p2; r2=$?; set -e

doc_lock=$(psql "$DBURL" -tAc "select lock_version from public.project_documents where id='$DOC'")
versions=$(psql "$DBURL" -tAc "select count(*) from public.project_document_versions where project_document_id='$DOC'")

echo "C50 results: rollback_tx=$r1 save_tx=$r2 doc_lock=$doc_lock versions=$versions"

# Valide uitkomsten:
#  (a) rollback wint: r1=0, r2!=0 (lock_version_mismatch),
#      doc_lock=2, versions=2 (seed + rollback-new)
#  (b) save wint: r2=0, r1!=0 (lock_version_mismatch),
#      doc_lock=2, versions=1 (rollback niet uitgevoerd)
if [[ $r1 -eq 0 && $r2 -ne 0 && "$doc_lock" == "2" && "$versions" == "2" ]] &&
   grep -qE 'lock_version_mismatch|serialization_failure' "$tmp2"; then
  echo "PASS: rollback-first-blocks-save"; rm -f "$tmp1" "$tmp2"; exit 0
fi
if [[ $r1 -ne 0 && $r2 -eq 0 && "$doc_lock" == "2" && "$versions" == "1" ]] &&
   grep -qE 'lock_version_mismatch|serialization_failure' "$tmp1"; then
  echo "PASS: save-first-blocks-rollback"; rm -f "$tmp1" "$tmp2"; exit 0
fi

echo "FAIL"; cat "$tmp1"; cat "$tmp2"; rm -f "$tmp1" "$tmp2"; exit 1

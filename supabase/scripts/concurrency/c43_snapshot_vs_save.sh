#!/usr/bin/env bash
# C43 — create_document_snapshot vs save_document_internal op hetzelfde doc.
# Beide RPCs nemen dezelfde lockketen (org→project→member→doc), dus ze
# serialiseren atomair op member(U) + doc(U). Geen deadlock.
#
# Verwacht: beide slagen (in willekeurige volgorde). Als snapshot eerst → doc
# blijft op lock_version=1; save daarna → lock_version=2. Snapshot ziet de
# waarde vóór of na save afhankelijk van winnaar.

set -euo pipefail
DBURL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:54322/postgres}"

psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/_seed.sql" >/dev/null

OWNER='11111111-0000-0000-0000-000000000001'
ORG=$(psql "$DBURL" -tAc "select id from public.organizations where slug='race-team'")

psql "$DBURL" -v ON_ERROR_STOP=1 -q <<SQL >/dev/null
select set_config('request.jwt.claims',
  '{"sub":"$OWNER","role":"authenticated"}', false);
select set_config('role','authenticated', false);
select public.create_project('$ORG', 'C43 project', 'website', null);
SET ROLE postgres;
insert into public.project_documents (project_id, doc, schema_version, updated_by)
select p.id,
       jsonb_build_object(
         'version','0.1.0',
         'project', jsonb_build_object('documentType','website','title','x'),
         'pages',   jsonb_build_array(jsonb_build_object('id','p','root',jsonb_build_object('id','r','type','text','props','{}'::jsonb)))
       ),
       '0.1.0',
       '$OWNER'
  from public.projects p where p.name='C43 project';
RESET ROLE;
SQL

PROJECT=$(psql "$DBURL" -tAc "select id from public.projects where name='C43 project'")
DOC=$(psql "$DBURL" -tAc "select id from public.project_documents where project_id='$PROJECT'")

tmp1=$(mktemp); tmp2=$(mktemp)
(
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    select set_config('request.jwt.claims',
      '{\"sub\":\"$OWNER\",\"role\":\"authenticated\"}', false);
    select set_config('role','authenticated', false);
    select public.create_document_snapshot('$DOC', 'c43');
    commit;
  " >"$tmp1" 2>&1
) &
p1=$!
(
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    SET ROLE service_role;
    select public.save_document_internal(
      '$OWNER'::uuid,
      '$PROJECT'::uuid,
      '{\"version\":\"0.1.0\",\"project\":{\"documentType\":\"website\",\"title\":\"c43-new\"},\"pages\":[{\"id\":\"p\",\"root\":{\"id\":\"r\",\"type\":\"text\",\"props\":{}}}]}'::jsonb,
      '0.1.0', 1);
    RESET ROLE;
    commit;
  " >"$tmp2" 2>&1
) &
p2=$!
set +e; wait $p1; r1=$?; wait $p2; r2=$?; set -e

doc_lock=$(psql "$DBURL" -tAc "select lock_version from public.project_documents where id='$DOC'")
versions=$(psql "$DBURL" -tAc "select count(*) from public.project_document_versions where project_document_id='$DOC'")

echo "C43 results: snapshot_tx=$r1 save_tx=$r2 doc_lock=$doc_lock versions=$versions"

# Beide moeten slagen (geen deadlock), doc_lock=2 (save committeerde), versions=1
if [[ $r1 -eq 0 && $r2 -eq 0 && "$doc_lock" == "2" && "$versions" == "1" ]]; then
  echo "PASS: both committed, no deadlock, invariant preserved"; rm -f "$tmp1" "$tmp2"; exit 0
fi

echo "FAIL"; cat "$tmp1"; cat "$tmp2"; rm -f "$tmp1" "$tmp2"; exit 1

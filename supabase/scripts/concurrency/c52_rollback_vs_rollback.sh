#!/usr/bin/env bash
# C52 — twee gelijktijdige rollback_to_version-calls op hetzelfde doc.
# Beide serialiseren op member(U) + doc(U); één wint via expected_lock_version,
# ander krijgt lock_version_mismatch. Historie krijgt exact één rollback-version.

set -euo pipefail
DBURL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/postgres}"

psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/_seed.sql" >/dev/null

OWNER='11111111-0000-0000-0000-000000000001'
ORG=$(psql "$DBURL" -tAc "select id from public.organizations where slug='race-team'")

psql "$DBURL" -v ON_ERROR_STOP=1 -q <<SQL >/dev/null
select set_config('request.jwt.claims',
  '{"sub":"$OWNER","role":"authenticated"}', false);
select set_config('role','authenticated', false);
select public.create_project('$ORG', 'C52 project', 'website', null);
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
  from public.projects p where p.name='C52 project';
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
  where d.project_id = (select id from public.projects where name='C52 project');
RESET ROLE;
SQL

DOC=$(psql "$DBURL" -tAc "
  select d.id from public.project_documents d
  join public.projects p on p.id = d.project_id
  where p.name='C52 project'")

tmp1=$(mktemp); tmp2=$(mktemp)
(
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
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    SET ROLE service_role;
    select public.rollback_to_version('$OWNER'::uuid, '$DOC'::uuid, 1, 1);
    RESET ROLE;
    commit;
  " >"$tmp2" 2>&1
) &
p2=$!
set +e; wait $p1; r1=$?; wait $p2; r2=$?; set -e

ok=0
[[ $r1 -eq 0 ]] && ok=$((ok+1))
[[ $r2 -eq 0 ]] && ok=$((ok+1))

doc_lock=$(psql "$DBURL" -tAc "select lock_version from public.project_documents where id='$DOC'")
versions=$(psql "$DBURL" -tAc "select count(*) from public.project_document_versions where project_document_id='$DOC'")

echo "C52 results: tx1=$r1 tx2=$r2 doc_lock=$doc_lock versions=$versions"

# Exact één moet slagen, ander krijgt lock_version_mismatch. Eindstate:
# doc_lock=2, versions=2 (seed + één rollback-new).
if [[ $ok -eq 1 && "$doc_lock" == "2" && "$versions" == "2" ]] &&
   grep -qE 'lock_version_mismatch|serialization_failure' "$tmp1" "$tmp2"; then
  echo "PASS: exactly one rollback succeeded; invariant preserved"
  rm -f "$tmp1" "$tmp2"; exit 0
fi

echo "FAIL"; cat "$tmp1"; cat "$tmp2"; rm -f "$tmp1" "$tmp2"; exit 1

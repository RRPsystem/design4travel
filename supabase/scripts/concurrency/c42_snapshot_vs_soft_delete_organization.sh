#!/usr/bin/env bash
# C42 — create_document_snapshot vs soft_delete_organization.
# Verwacht: één slaagt cleanly.
#   snapshot eerst commit → delete wacht op FOR UPDATE org (blocked by snapshot's
#                           FOR SHARE), commit erna → versions=1, org deleted=yes
#   delete eerst commit    → snapshot raise organization_not_active
#                           → versions=0, org deleted=yes
#
# Voor deze test moet de owner nog een tweede owner naast zich hebben, anders
# blokkeert de last-owner-invariant de leave-flow (soft_delete_organization
# staat één owner toe, geen last-owner-check nodig; die is er alleen bij leave).

set -euo pipefail
DBURL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:54322/postgres}"

psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/_seed.sql" >/dev/null

OWNER='11111111-0000-0000-0000-000000000001'
ORG=$(psql "$DBURL" -tAc "select id from public.organizations where slug='race-team'")

psql "$DBURL" -v ON_ERROR_STOP=1 -q <<SQL >/dev/null
select set_config('request.jwt.claims',
  '{"sub":"$OWNER","role":"authenticated"}', false);
select set_config('role','authenticated', false);
select public.create_project('$ORG', 'C42 project', 'website', null);
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
  from public.projects p where p.name='C42 project';
RESET ROLE;
SQL

DOC=$(psql "$DBURL" -tAc "
  select d.id from public.project_documents d
  join public.projects p on p.id = d.project_id
  where p.name='C42 project'")

tmp1=$(mktemp); tmp2=$(mktemp)
(
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    select set_config('request.jwt.claims',
      '{\"sub\":\"$OWNER\",\"role\":\"authenticated\"}', false);
    select set_config('role','authenticated', false);
    select public.create_document_snapshot('$DOC', 'c42');
    commit;
  " >"$tmp1" 2>&1
) &
p1=$!
(
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    select set_config('request.jwt.claims',
      '{\"sub\":\"$OWNER\",\"role\":\"authenticated\"}', false);
    select set_config('role','authenticated', false);
    select public.soft_delete_organization('$ORG');
    commit;
  " >"$tmp2" 2>&1
) &
p2=$!
set +e; wait $p1; r1=$?; wait $p2; r2=$?; set -e

org_deleted=$(psql "$DBURL" -tAc "
  select case when deleted_at is null then 'no' else 'yes' end
  from public.organizations where id='$ORG'")
versions=$(psql "$DBURL" -tAc "select count(*) from public.project_document_versions where project_document_id='$DOC'")

echo "C42 results: snapshot_tx=$r1 delete_tx=$r2 org_deleted=$org_deleted versions=$versions"

if [[ $r1 -eq 0 && $r2 -eq 0 && "$org_deleted" == "yes" && "$versions" == "1" ]]; then
  echo "PASS: snapshot-first-then-delete"; rm -f "$tmp1" "$tmp2"; exit 0
fi
if [[ $r1 -ne 0 && $r2 -eq 0 && "$org_deleted" == "yes" && "$versions" == "0" ]] &&
   grep -qE 'organization_not_active|serialization_failure' "$tmp1"; then
  echo "PASS: delete-first-blocks-snapshot"; rm -f "$tmp1" "$tmp2"; exit 0
fi

echo "FAIL"; cat "$tmp1"; cat "$tmp2"; rm -f "$tmp1" "$tmp2"; exit 1

#!/usr/bin/env bash
# C40 — create_document_snapshot vs remove_member op de snapshot-uitvoerder.
# Verwacht: één slaagt cleanly, invariant "geen snapshot met ingetrokken rol".
#   snapshot eerst commit → remove wacht op FOR SHARE org, commit erna
#                           → snapshot heeft version_number 1, editor is weg
#   remove eerst commit    → snapshot raise membership_not_active,
#                           → geen version_number 1

set -euo pipefail
DBURL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:54322/postgres}"

psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/_seed.sql" >/dev/null

OWNER='11111111-0000-0000-0000-000000000001'
EDITOR='33333333-0000-0000-0000-000000000003'
ORG=$(psql "$DBURL" -tAc "select id from public.organizations where slug='race-team'")

# Project + doc seeden
psql "$DBURL" -v ON_ERROR_STOP=1 -q <<SQL >/dev/null
select set_config('request.jwt.claims',
  '{"sub":"$OWNER","role":"authenticated"}', false);
select set_config('role','authenticated', false);
select public.create_project('$ORG', 'C40 project', 'website', null);
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
  from public.projects p where p.name='C40 project';
RESET ROLE;
SQL

DOC=$(psql "$DBURL" -tAc "
  select d.id from public.project_documents d
  join public.projects p on p.id = d.project_id
  where p.name='C40 project'")
EDITOR_MEM=$(psql "$DBURL" -tAc "select id from public.organization_members where user_id='$EDITOR' and organization_id='$ORG' and deleted_at is null")

tmp1=$(mktemp); tmp2=$(mktemp)
(
  # editor doet create_document_snapshot
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    select set_config('request.jwt.claims',
      '{\"sub\":\"$EDITOR\",\"role\":\"authenticated\"}', false);
    select set_config('role','authenticated', false);
    select public.create_document_snapshot('$DOC', 'c40');
    commit;
  " >"$tmp1" 2>&1
) &
p1=$!
(
  # owner verwijdert editor
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    select set_config('request.jwt.claims',
      '{\"sub\":\"$OWNER\",\"role\":\"authenticated\"}', false);
    select set_config('role','authenticated', false);
    select public.remove_member('$EDITOR_MEM');
    commit;
  " >"$tmp2" 2>&1
) &
p2=$!
set +e; wait $p1; r1=$?; wait $p2; r2=$?; set -e

editor_active=$(psql "$DBURL" -tAc "
  select case when deleted_at is null then 'yes' else 'no' end
  from public.organization_members where id='$EDITOR_MEM'")
versions=$(psql "$DBURL" -tAc "select count(*) from public.project_document_versions where project_document_id='$DOC'")

echo "C40 results: snapshot_tx=$r1 remove_tx=$r2 editor_active=$editor_active versions=$versions"

# Uitkomsten:
#  (a) snapshot wint: r1=0, r2=0, editor_active=no na commit, versions=1
#  (b) remove wint: r2=0, r1!=0 (membership_not_active), editor_active=no, versions=0
if [[ $r1 -eq 0 && $r2 -eq 0 && "$editor_active" == "no" && "$versions" == "1" ]]; then
  echo "PASS: snapshot-first-then-remove"; rm -f "$tmp1" "$tmp2"; exit 0
fi
if [[ $r1 -ne 0 && $r2 -eq 0 && "$editor_active" == "no" && "$versions" == "0" ]] &&
   grep -qE 'membership_not_active|serialization_failure' "$tmp1"; then
  echo "PASS: remove-first-blocks-snapshot"; rm -f "$tmp1" "$tmp2"; exit 0
fi

echo "FAIL"; cat "$tmp1"; cat "$tmp2"; rm -f "$tmp1" "$tmp2"; exit 1

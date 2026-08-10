#!/usr/bin/env bash
# C11 — accept_invitation vs soft_delete_organization.
# Verwacht:
#   soft-delete eerst → accept raise organization_not_active_at_acceptance
#   accept eerst → soft-delete wacht op FOR SHARE tot accept commit, dan slaagt
#                 soft-delete; nieuwe member is meteen daarna niet meer actief

set -euo pipefail
DBURL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:54322/postgres}"

psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/_seed.sql" >/dev/null

# Extra: invitee-user + invitation
psql "$DBURL" -v ON_ERROR_STOP=1 -q -c "
insert into auth.users (id, instance_id, email, encrypted_password, raw_app_meta_data,
                        raw_user_meta_data, aud, role, email_confirmed_at, created_at, updated_at)
values ('99999999-0000-0000-0000-000000000099',
        '00000000-0000-0000-0000-000000000000',
        'invitee@race.local','','{}'::jsonb,'{}'::jsonb,
        'authenticated','authenticated', now(), now(), now())
on conflict do nothing;
" >/dev/null

OWNER='11111111-0000-0000-0000-000000000001'
INVITEE='99999999-0000-0000-0000-000000000099'
ORG=$(psql "$DBURL" -tAc "select id from public.organizations where slug='race-team'")

TOKEN=$(psql "$DBURL" -tAc "
  select set_config('request.jwt.claims',
    '{\"sub\":\"$OWNER\",\"role\":\"authenticated\"}', false);
  select set_config('role','authenticated', false);
  select public.invite_member('$ORG', 'invitee@race.local', 'editor');
" | tail -1 | tr -d '[:space:]')

tmp1=$(mktemp); tmp2=$(mktemp)
(
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    select set_config('request.jwt.claims',
      '{\"sub\":\"$INVITEE\",\"role\":\"authenticated\"}', false);
    select set_config('role','authenticated', false);
    select public.accept_invitation('$TOKEN');
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
invitee_member=$(psql "$DBURL" -tAc "
  select count(*) from public.organization_members
  where organization_id='$ORG' and user_id='$INVITEE' and deleted_at is null")

echo "C11 results: accept_tx=$r1 delete_tx=$r2 org_deleted=$org_deleted invitee_member=$invitee_member"

# Uitkomsten:
#  (a) accept eerst commit, delete daarna: r1=0, r2=0, org_deleted=yes, invitee_member=1 (rij bestaat maar org is dood → user ziet niks)
#  (b) delete eerst: r1!=0 (organization_not_active_at_acceptance), r2=0, org_deleted=yes, invitee_member=0
if [[ $r1 -eq 0 && $r2 -eq 0 && "$org_deleted" == "yes" && "$invitee_member" -eq 1 ]]; then
  echo "PASS: accept-first-then-delete"; rm -f "$tmp1" "$tmp2"; exit 0
fi
if [[ $r1 -ne 0 && $r2 -eq 0 && "$org_deleted" == "yes" && "$invitee_member" -eq 0 ]] &&
   grep -qE 'organization_not_active_at_acceptance|organization_not_active|serialization_failure' "$tmp1"; then
  echo "PASS: delete-first-blocks-accept"; rm -f "$tmp1" "$tmp2"; exit 0
fi

echo "FAIL"; cat "$tmp1"; cat "$tmp2"; rm -f "$tmp1" "$tmp2"; exit 1

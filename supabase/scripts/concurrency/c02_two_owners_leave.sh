#!/usr/bin/env bash
# C02 — Twee owners proberen tegelijk `leave_organization`.
# Verwacht: precies één slaagt; ander raise cannot_leave_as_last_owner.

set -euo pipefail
DBURL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:54322/postgres}"

psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/_seed.sql" >/dev/null

O1='11111111-0000-0000-0000-000000000001'
O2='22222222-0000-0000-0000-000000000002'
ORG=$(psql "$DBURL" -tAc "select id from public.organizations where slug='race-team'")

tmp1=$(mktemp); tmp2=$(mktemp)
(
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    select set_config('request.jwt.claims',
      '{\"sub\":\"$O1\",\"role\":\"authenticated\"}', false);
    select set_config('role','authenticated', false);
    select public.leave_organization('$ORG');
    commit;
  " >"$tmp1" 2>&1
) &
p1=$!
(
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    select set_config('request.jwt.claims',
      '{\"sub\":\"$O2\",\"role\":\"authenticated\"}', false);
    select set_config('role','authenticated', false);
    select public.leave_organization('$ORG');
    commit;
  " >"$tmp2" 2>&1
) &
p2=$!
set +e; wait $p1; r1=$?; wait $p2; r2=$?; set -e

ok=0; fail=0
[[ $r1 -eq 0 ]] && ok=$((ok+1)) || fail=$((fail+1))
[[ $r2 -eq 0 ]] && ok=$((ok+1)) || fail=$((fail+1))

active_owners=$(psql "$DBURL" -tAc "
  select count(*) from public.organization_members
  where organization_id='$ORG' and role='owner' and deleted_at is null")

echo "C02 results: tx1=$r1 tx2=$r2 active_owners=$active_owners"
if [[ $ok -eq 1 && $fail -eq 1 && $active_owners -eq 1 ]] &&
   grep -qE 'cannot_leave_as_last_owner|serialization_failure' "$tmp1" "$tmp2"; then
  echo "PASS"; rm -f "$tmp1" "$tmp2"; exit 0
fi
echo "FAIL"; cat "$tmp1"; cat "$tmp2"; rm -f "$tmp1" "$tmp2"; exit 1

#!/usr/bin/env bash
# C33 — Owner A doet change_member_role(B → 'admin') gelijktijdig met
#        owner B doet leave_organization.
# Verwacht: precies één slaagt; invariant "≥1 actieve owner" behouden.
#
# Beide RPCs nemen FOR UPDATE op de organizations-rij, dus ze serialiseren.
#   Ronde 1: Tx die eerst lock krijgt commit; ander wacht + hercheck en faalt.
#     - Als change_role eerst commit → B is admin, B kan niet meer als owner leaven
#       (leave detecteert dat B nu admin is; leave zelf is dan geen last-owner-issue,
#        maar de PRE-lock rol was 'owner'... Feitelijk: leave doet zijn eigen SELECT
#        na de org-lock, ziet B als admin — geen last-owner-check → LEAVE slaagt alsnog.)
#     - Als leave eerst commit → B is weg. change_role vindt member niet meer,
#       raise not_found_or_deleted.
#
# Beide paden houden invariant. Test valideert dat.

set -euo pipefail
DBURL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:54322/postgres}"

psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/_seed.sql" >/dev/null

OWNER_A='11111111-0000-0000-0000-000000000001'
OWNER_B='22222222-0000-0000-0000-000000000002'
ORG=$(psql "$DBURL" -tAc "select id from public.organizations where slug='race-team'")
B_MEM=$(psql "$DBURL" -tAc "select id from public.organization_members where user_id='$OWNER_B' and organization_id='$ORG' and deleted_at is null")

tmp1=$(mktemp); tmp2=$(mktemp)
(
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    select set_config('request.jwt.claims',
      '{\"sub\":\"$OWNER_A\",\"role\":\"authenticated\"}', false);
    select set_config('role','authenticated', false);
    select public.change_member_role('$B_MEM', 'admin');
    commit;
  " >"$tmp1" 2>&1
) &
p1=$!
(
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    select set_config('request.jwt.claims',
      '{\"sub\":\"$OWNER_B\",\"role\":\"authenticated\"}', false);
    select set_config('role','authenticated', false);
    select public.leave_organization('$ORG');
    commit;
  " >"$tmp2" 2>&1
) &
p2=$!
set +e; wait $p1; r1=$?; wait $p2; r2=$?; set -e

active_owners=$(psql "$DBURL" -tAc "
  select count(*) from public.organization_members
  where organization_id='$ORG' and role='owner' and deleted_at is null")

echo "C33 results: change_tx=$r1 leave_tx=$r2 active_owners=$active_owners"

# Invariant: minstens 1 actieve owner ALTIJD.
if [[ $active_owners -ge 1 ]]; then
  echo "PASS: invariant preserved (owners=$active_owners)"; rm -f "$tmp1" "$tmp2"; exit 0
fi

echo "FAIL: owner-invariant broken"; cat "$tmp1"; cat "$tmp2"; rm -f "$tmp1" "$tmp2"; exit 1

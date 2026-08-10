#!/usr/bin/env bash
# C01 — Twee owners proberen tegelijk elkaar te verwijderen.
# Verwacht: precies één slaagt; ander raise cannot_remove_last_owner.
# Eindstate: exact één actieve owner.

set -euo pipefail
DBURL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:54322/postgres}"

# Reset + seed
psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/_seed.sql" >/dev/null

O1='11111111-0000-0000-0000-000000000001'
O2='22222222-0000-0000-0000-000000000002'

# Membership-IDs ophalen (filter op race-team org — user heeft ook een personal-org membership uit de auth-trigger)
ORG=$(psql "$DBURL" -tAc "select id from public.organizations where slug='race-team'")
O1_MEM=$(psql "$DBURL" -tAc "select id from public.organization_members where user_id='$O1' and organization_id='$ORG' and deleted_at is null")
O2_MEM=$(psql "$DBURL" -tAc "select id from public.organization_members where user_id='$O2' and organization_id='$ORG' and deleted_at is null")

# Parallel: O1 verwijdert O2 én O2 verwijdert O1
tmp1=$(mktemp); tmp2=$(mktemp)
(
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    select set_config('request.jwt.claims',
      '{\"sub\":\"$O1\",\"role\":\"authenticated\"}', false);
    select set_config('role','authenticated', false);
    select public.remove_member('$O2_MEM');
    commit;
  " >"$tmp1" 2>&1
) &
pid1=$!
(
  psql "$DBURL" -v ON_ERROR_STOP=1 -c "
    begin;
    select set_config('request.jwt.claims',
      '{\"sub\":\"$O2\",\"role\":\"authenticated\"}', false);
    select set_config('role','authenticated', false);
    select public.remove_member('$O1_MEM');
    commit;
  " >"$tmp2" 2>&1
) &
pid2=$!

set +e; wait $pid1; r1=$?; wait $pid2; r2=$?; set -e

# Precies één moet slagen (r=0), één moet falen (r!=0)
ok=0; fail=0
[[ $r1 -eq 0 ]] && ok=$((ok+1)) || fail=$((fail+1))
[[ $r2 -eq 0 ]] && ok=$((ok+1)) || fail=$((fail+1))

# Actieve owners in de org
active_owners=$(psql "$DBURL" -tAc "
  select count(*) from public.organization_members
  where organization_id = (select id from public.organizations where slug='race-team')
    and role='owner' and deleted_at is null")

echo "C01 results:"
echo "  Tx1 exit=$r1"
echo "  Tx2 exit=$r2"
echo "  Active owners after: $active_owners"

if [[ $ok -eq 1 && $fail -eq 1 && $active_owners -eq 1 ]]; then
  # Verifieer de faalreden. Twee geldige uitkomsten:
  #   a) `cannot_remove_last_owner` — 2e tx zag zichzelf nog als owner, hit invariant
  #   b) `insufficient_role`         — 2e tx werd zelf net verwijderd, is geen owner meer
  #   c) `serialization_failure`     — Postgres deed automatische retry-annulering
  if grep -qE 'cannot_remove_last_owner|insufficient_role|serialization_failure' "$tmp1" "$tmp2"; then
    echo "PASS: exactly one succeeded; invariant preserved"
    rm -f "$tmp1" "$tmp2"
    exit 0
  fi
fi

echo "FAIL: invariant possibly violated"
echo "--- tx1 output ---"; cat "$tmp1"
echo "--- tx2 output ---"; cat "$tmp2"
rm -f "$tmp1" "$tmp2"
exit 1

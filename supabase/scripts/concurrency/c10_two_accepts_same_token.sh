#!/usr/bin/env bash
# C10 — Twee gelijktijdige accept_invitation-calls met hetzelfde token.
# Verwacht: precies één slaagt; ander raise invitation_invalid_expired_or_email_mismatch.

set -euo pipefail
DBURL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:54322/postgres}"

psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/_seed.sql" >/dev/null

# Extra user 'invitee'
psql "$DBURL" -v ON_ERROR_STOP=1 -q -c "
insert into auth.users (id, instance_id, email, encrypted_password, raw_app_meta_data,
                        raw_user_meta_data, aud, role, email_confirmed_at, created_at, updated_at)
values ('99999999-0000-0000-0000-000000000099',
        '00000000-0000-0000-0000-000000000000',
        'invitee@race.local','','{}'::jsonb,'{}'::jsonb,
        'authenticated','authenticated', now(), now(), now())
on conflict do nothing;
" >/dev/null

# Genereer invitation
ORG=$(psql "$DBURL" -tAc "select id from public.organizations where slug='race-team'")
TOKEN=$(psql "$DBURL" -tAc "
  select set_config('request.jwt.claims',
    '{\"sub\":\"11111111-0000-0000-0000-000000000001\",\"role\":\"authenticated\"}', false);
  select set_config('role','authenticated', false);
  select public.invite_member('$ORG', 'invitee@race.local', 'editor');
" | tail -1 | tr -d '[:space:]')

if [[ -z "$TOKEN" ]]; then echo "seed failed: no token"; exit 1; fi

INVITEE='99999999-0000-0000-0000-000000000099'
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
      '{\"sub\":\"$INVITEE\",\"role\":\"authenticated\"}', false);
    select set_config('role','authenticated', false);
    select public.accept_invitation('$TOKEN');
    commit;
  " >"$tmp2" 2>&1
) &
p2=$!
set +e; wait $p1; r1=$?; wait $p2; r2=$?; set -e

ok=0
[[ $r1 -eq 0 ]] && ok=$((ok+1))
[[ $r2 -eq 0 ]] && ok=$((ok+1))

members=$(psql "$DBURL" -tAc "
  select count(*) from public.organization_members
  where organization_id='$ORG' and user_id='$INVITEE' and deleted_at is null")

echo "C10 results: tx1=$r1 tx2=$r2 memberships=$members"
if [[ $ok -eq 1 && $members -eq 1 ]] &&
   grep -qE 'invitation_invalid_expired_or_email_mismatch|serialization_failure' "$tmp1" "$tmp2"; then
  echo "PASS"; rm -f "$tmp1" "$tmp2"; exit 0
fi
echo "FAIL"; cat "$tmp1"; cat "$tmp2"; rm -f "$tmp1" "$tmp2"; exit 1

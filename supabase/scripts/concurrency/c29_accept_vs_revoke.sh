#!/usr/bin/env bash
# C29 — accept_invitation en revoke_invitation tegelijk op zelfde invitation.
# Verwacht: precies één sluitende uitkomst.
#   - Accept eerst commit → invite=accepted, revoke = 0 rows (idempotent, exit 0)
#   - Revoke eerst commit → accept faalt met invitation_invalid_expired_or_email_mismatch

set -euo pipefail
DBURL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:54322/postgres}"

psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$(dirname "$0")/_seed.sql" >/dev/null

psql "$DBURL" -v ON_ERROR_STOP=1 -q -c "
insert into auth.users (id, instance_id, email, encrypted_password, raw_app_meta_data,
                        raw_user_meta_data, aud, role, email_confirmed_at, created_at, updated_at)
values ('99999999-0000-0000-0000-000000000099',
        '00000000-0000-0000-0000-000000000000',
        'invitee@race.local','','{}'::jsonb,'{}'::jsonb,
        'authenticated','authenticated', now(), now(), now())
on conflict do nothing;
" >/dev/null

ORG=$(psql "$DBURL" -tAc "select id from public.organizations where slug='race-team'")
TOKEN=$(psql "$DBURL" -tAc "
  select set_config('request.jwt.claims',
    '{\"sub\":\"11111111-0000-0000-0000-000000000001\",\"role\":\"authenticated\"}', false);
  select set_config('role','authenticated', false);
  select public.invite_member('$ORG', 'invitee@race.local', 'editor');
" | tail -1 | tr -d '[:space:]')

INV_ID=$(psql "$DBURL" -tAc "
  select id from public.organization_invitations
  where token_hash = extensions.digest('$TOKEN','sha256')")

INVITEE='99999999-0000-0000-0000-000000000099'
OWNER='11111111-0000-0000-0000-000000000001'

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
    select public.revoke_invitation('$INV_ID');
    commit;
  " >"$tmp2" 2>&1
) &
p2=$!
set +e; wait $p1; r1=$?; wait $p2; r2=$?; set -e

state=$(psql "$DBURL" -tAc "
  select case
    when accepted_at is not null then 'accepted'
    when revoked_at  is not null then 'revoked'
    else 'pending'
  end from public.organization_invitations where id='$INV_ID'")

members=$(psql "$DBURL" -tAc "
  select count(*) from public.organization_members
  where organization_id='$ORG' and user_id='$INVITEE' and deleted_at is null")

echo "C29 results: accept_tx=$r1 revoke_tx=$r2 inv_state=$state active_members=$members"

# Valide eindstates:
#   state=accepted, members=1  → accept eerst
#   state=revoked, members=0   → revoke eerst; accept moet dan zijn gefaald
if [[ "$state" == "accepted" && $members -eq 1 && $r1 -eq 0 ]]; then
  echo "PASS: accept-first path"; rm -f "$tmp1" "$tmp2"; exit 0
fi
if [[ "$state" == "revoked" && $members -eq 0 && $r1 -ne 0 && $r2 -eq 0 ]] &&
   grep -q 'invitation_invalid_expired_or_email_mismatch' "$tmp1"; then
  echo "PASS: revoke-first path"; rm -f "$tmp1" "$tmp2"; exit 0
fi

echo "FAIL"; cat "$tmp1"; cat "$tmp2"; rm -f "$tmp1" "$tmp2"; exit 1

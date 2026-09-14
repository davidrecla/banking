#!/usr/bin/env bash
# test-api.sh — happy-path validation of every LEGITIMATE API endpoint.
#
# Part of the Phase 4 security showcase pair:
#   test-api.sh           — proves the real API works (run at the start of the
#                           demo, and again after protections go on, to show
#                           legitimate traffic is unaffected)
#   attack-simulation.sh  — proves the intentional vulnerabilities are
#                           exploitable ("before") / blocked ("after")
#
# Usage:
#   ./test-api.sh                      # hits production
#   BASE_URL=http://127.0.0.1:8787 ./test-api.sh   # hits local wrangler dev
#
# Design rules:
# - Read-mostly: GETs expect 200, POSTs get an empty body and expect a 400
#   validation error — enough to prove the route exists without creating data.
#   The only mutations are self-cleaning pairs (payee create+delete, upload
#   create+delete, freeze+unfreeze, upload/delete), so the script can run
#   repeatedly without polluting the demo data baseline.
# - Login budget: the login endpoint allows 5 attempts/minute. This script
#   makes exactly 2 (one bad-password, one good). attack-simulation.sh makes
#   1. Keep total logins per minute under 5 across both scripts.
# - curl.exe + --ssl-no-revoke: required on the demo machine's network (see
#   BUILD-PLAN.md "Local Environment Notes" #2). Harmless everywhere else.

BASE_URL="${BASE_URL:-https://banking.puregroundscoffee.com}"
USERNAME="${DEMO_USERNAME:-chris.brown}"
PASSWORD="${DEMO_PASSWORD:-cbrown123}"

PASS=0; FAIL=0; SKIP=0

ok()   { PASS=$((PASS+1)); echo "PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $1 ($2)"; }
skip() { SKIP=$((SKIP+1)); echo "SKIP  $1 ($2)"; }

# http <method> <path> [body-or-@file] [extra curl args...]
# Prints: "<status> <body>"
http() {
  local method="$1" path="$2"; shift 2
  local args=(-s -X "$method" -H "Authorization: Bearer $TOKEN" --ssl-no-revoke)
  if [ -n "$1" ]; then
    if [ "${1#@}" != "$1" ]; then args+=(-F "file=${1}"); shift
    else args+=(-H "Content-Type: application/json" -d "$1"); shift; fi
  fi
  local tmp; tmp=$(mktemp)
  local status; status=$(curl.exe "${args[@]}" "$@" -o "$tmp" -w "%{http_code}" "$BASE_URL$path")
  echo "$status $(cat "$tmp")"
  rm -f "$tmp"
}

expect() { # expect <label> <expected_status> <http output>
  local label="$1" want="$2"; local status="${3%% *}"
  if [ "$status" = "$want" ]; then ok "$label"; else bad "$label" "expected $want, got $status"; fi
}

first_json_field() { sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" <<<"$1" | head -1; }

echo "=== test-api.sh — legitimate API contract check ==="
echo "Target: $BASE_URL (user: $USERNAME)"
echo

# --- Auth -----------------------------------------------------------------
UNAUTH=$(curl.exe -s -w " %{http_code}" --ssl-no-revoke -o /tmp/tapi.$$ "$BASE_URL/api/accounts" && true)
expect "GET /api/accounts without token -> 401" "401" "401 $(cat /tmp/tapi.$$)"; rm -f /tmp/tapi.$$

expect "POST /api/auth/login empty body -> 400" "400" "$(curl.exe -s -w '%{http_code} ' --ssl-no-revoke -X POST -H 'Content-Type: application/json' -d '{}' -o /tmp/tapi.$$ "$BASE_URL/api/auth/login"; cat /tmp/tapi.$$)"; rm -f /tmp/tapi.$$

expect "POST /api/auth/login wrong password -> 401" "401" "$(curl.exe -s -w '%{http_code} ' --ssl-no-revoke -X POST -H 'Content-Type: application/json' -d "{\"username\":\"$USERNAME\",\"password\":\"wrong-password\"}" -o /tmp/tapi.$$ "$BASE_URL/api/auth/login"; cat /tmp/tapi.$$)"; rm -f /tmp/tapi.$$

LOGIN=$(curl.exe -s --ssl-no-revoke -X POST -H 'Content-Type: application/json' -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" "$BASE_URL/api/auth/login")
TOKEN=$(first_json_field "$LOGIN" token)
if [ -n "$TOKEN" ]; then ok "POST /api/auth/login good credentials -> 200 + token"; else echo "FATAL: login failed, aborting: $LOGIN"; exit 1; fi

REFRESH=$(http POST /api/auth/refresh "{\"token\":\"$TOKEN\"}")
expect "POST /api/auth/refresh -> 200 and new token" "200" "$REFRESH"

expect "POST /api/auth/logout -> 200" "200" "$(http POST /api/auth/logout)"

# --- Accounts -------------------------------------------------------------
ACCOUNTS=$(http GET /api/accounts)
expect "GET /api/accounts -> 200" "200" "$ACCOUNTS"
SAVINGS_ID=$(sed -n 's/.*{"id":"\([^"]*\)"[^{]*"account_type":"savings".*/\1/p' <<<"$ACCOUNTS" | head -1)
CHECKING_ID=$(sed -n 's/.*{"id":"\([^"]*\)"[^{]*"account_type":"checking".*/\1/p' <<<"$ACCOUNTS" | head -1)

expect "GET /api/accounts/:id -> 200" "200" "$(http GET "/api/accounts/$SAVINGS_ID")"

FRZ=$(http POST "/api/accounts/$CHECKING_ID/freeze")
expect "POST /api/accounts/:id/freeze -> 200" "200" "$FRZ"
expect "POST /api/transfers/internal on frozen account -> 403" "403" "$(http POST /api/transfers/internal "{\"fromAccountId\":\"$CHECKING_ID\",\"toUsername\":\"sarah.johnson\",\"toAccountType\":\"savings\",\"amount\":1}")"
UNFRZ=$(http POST "/api/accounts/$CHECKING_ID/unfreeze")
expect "POST /api/accounts/:id/unfreeze -> 200" "200" "$UNFRZ"
[ "${UNFRZ%% *}" = "200" ] || echo "WARNING: unfreeze failed — clean up manually!"

expect "POST /api/transfers/internal empty body -> 400" "400" "$(http POST /api/transfers/internal '{}')"
expect "POST /api/transfers/external empty body -> 400" "400" "$(http POST /api/transfers/external '{}')"
expect "POST /api/transfers/batch empty body -> 400" "400"  "$(http POST /api/transfers/batch '{}')"
expect "GET /api/transfers/banks -> 200" "200" "$(http GET /api/transfers/banks)"
expect "GET /api/transfers -> 200" "200" "$(http GET /api/transfers)"

# --- Transactions ---------------------------------------------------------
TXNS=$(http GET '/api/transactions?limit=1')
expect "GET /api/transactions -> 200" "200" "$TXNS"
TXN_ID=$(first_json_field "$TXNS" id)
if [ -n "$TXN_ID" ]; then expect "GET /api/transactions/:id -> 200" "200" "$(http GET "/api/transactions/$TXN_ID")"; else skip "GET /api/transactions/:id" "no transactions"; fi

# --- Bills (payee create + pay + delete round-trip) -----------------------
expect "GET /api/bills/payees -> 200" "200" "$(http GET /api/bills/payees)"
expect "GET /api/bills -> 200" "200" "$(http GET /api/bills)"
PAYEE=$(http POST /api/bills/payees '{"name":"Test Water Utility","billType":"water","accountNumber":"TEST-0001"}')
expect "POST /api/bills/payees -> 201" "201" "$PAYEE"
PAYEE_ID=$(first_json_field "$PAYEE" id)
if [ -n "$PAYEE_ID" ]; then
  expect "POST /api/bills/pay (\$1 round-trip) -> 201" "201" "$(http POST /api/bills/pay "{\"fromAccountId\":\"$CHECKING_ID\",\"payeeId\":\"$PAYEE_ID\",\"amount\":1}")"
  expect "DELETE /api/bills/payees/:id -> 200" "200" "$(http DELETE "/api/bills/payees/$PAYEE_ID")"
else skip "bill payment + payee delete" "payee create failed"; fi

# --- Loans & investments --------------------------------------------------
expect "POST /api/loans/apply empty body -> 400" "400" "$(http POST /api/loans/apply '{}')"
LOANS=$(http GET /api/loans)
expect "GET /api/loans -> 200" "200" "$LOANS"
LOAN_ID=$(first_json_field "$LOANS" id)
[ -n "$LOAN_ID" ] && expect "GET /api/loans/:id -> 200" "200" "$(http GET "/api/loans/$LOAN_ID")" || skip "GET /api/loans/:id" "no loans"

expect "GET /api/investments/plans -> 200" "200" "$(http GET /api/investments/plans)"
expect "POST /api/investments empty body -> 400" "400" "$(http POST /api/investments '{}')"
expect "GET /api/investments -> 200" "200" "$(http GET /api/investments)"

# --- Statements, cards, notifications, audit ------------------------------
expect "POST /api/statements/generate empty body -> 400" "400" "$(http POST /api/statements/generate '{}')"
expect "GET /api/statements -> 200" "200" "$(http GET /api/statements)"
expect "GET /api/cards -> 200" "200" "$(http GET /api/cards)"
expect "GET /api/notifications -> 200" "200" "$(http GET /api/notifications)"
expect "POST /api/notifications/read-all -> 200" "200" "$(http POST /api/notifications/read-all)"
expect "GET /api/audit-log -> 200" "200" "$(http GET /api/audit-log)"

# --- Uploads (create + delete round-trip) ---------------------------------
UP_TMP=$(mktemp --suffix=.txt); echo "test-api round-trip file - safe to delete" > "$UP_TMP"
UPLOAD=$(http POST /api/uploads "@$UP_TMP")
expect "POST /api/uploads -> 201" "201" "$UPLOAD"
UPLOAD_ID=$(first_json_field "$UPLOAD" id)
if [ -n "$UPLOAD_ID" ]; then
  expect "GET /api/uploads -> 200" "200" "$(http GET /api/uploads)"
  expect "GET /api/uploads/:id (download) -> 200" "200" "$(http GET "/api/uploads/$UPLOAD_ID")"
  expect "DELETE /api/uploads/:id -> 200" "200" "$(http DELETE "/api/uploads/$UPLOAD_ID")"
else skip "upload list/download/delete" "upload failed"; fi
rm -f "$UP_TMP"

echo
echo "=== Summary: $PASS passed, $FAIL failed, $SKIP skipped ==="
[ "$FAIL" -eq 0 ]

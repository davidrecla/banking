#!/usr/bin/env bash
# load-attacker.sh — one-command demo session bootstrap.
#
#   source scripts/load-attacker.sh
#
# Logs in as the demo attacker (an ordinary customer), and sets in your
# CURRENT shell (that's why it must be sourced, not executed):
#   BASE        target app URL
#   TOKEN       his JWT ("key card") — every attack command in the POC guide
#               Tab 2 sends it as: -H "Authorization: Bearer $TOKEN"
#   SAVINGS_ID  his savings account id — destination for money-moving attacks
#
# Also writes /tmp/pgc-attacker.env so a SECOND terminal window on the same
# machine can skip the login entirely:  source /tmp/pgc-attacker.env
# (Respects the login rate limit — 5/min — and the 24h token lifetime.)

# Guard: has to be sourced, or the variables die with the subshell.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "Run me with 'source':  source scripts/load-attacker.sh"
  exit 1
fi

# Cross-platform curl (same convention as test-api.sh / attack-simulation.sh).
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) CURL=(curl.exe -s --ssl-no-revoke) ;;
  *)                    CURL=(curl -s) ;;
esac

BASE="${BASE_URL:-https://banking.puregroundscoffee.com}"
USERNAME="${DEMO_USERNAME:-chris.brown}"
PASSWORD="${DEMO_PASSWORD:-cbrown123}"

RESP=$("${CURL[@]}" -w $'\n%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" "$BASE/api/auth/login")
CODE=${RESP##*$'\n'}; LOGIN=${RESP%$'\n'*}
TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' <<<"$LOGIN" | head -1)
if [ -z "$TOKEN" ]; then
  echo "ATTACKER LOGIN FAILED — HTTP $CODE: $LOGIN"
  case "$LOGIN" in
    *"Too many login attempts"*) echo "  → 5 logins/min per user. Wait 60 seconds, then run me again — or just use: source /tmp/pgc-attacker.env" ;;
    *"Invalid username or password"*) echo "  → the app rejected the hardcoded credentials. Verify by hand:" ; echo "    curl -i -X POST -H 'Content-Type: application/json' -d '{\"username\":\"chris.brown\",\"password\":\"cbrown123\"}' $BASE/api/auth/login" ;;
  esac
  return 1 2>/dev/null || exit 1
fi

ACCOUNTS=$("${CURL[@]}" -H "Authorization: Bearer $TOKEN" "$BASE/api/accounts")
SAVINGS_ID=$(sed -n 's/.*{"id":"\([^"]*\)"[^{]*"account_type":"savings".*/\1/p' <<<"$ACCOUNTS" | head -1)

export BASE TOKEN SAVINGS_ID
printf 'export BASE=%q\nexport TOKEN=%q\nexport SAVINGS_ID=%q\n' \
  "$BASE" "$TOKEN" "$SAVINGS_ID" > /tmp/pgc-attacker.env

echo "attacker session loaded: $USERNAME @ $BASE"
echo "  savings account: $SAVINGS_ID"
echo "  extra terminals: source /tmp/pgc-attacker.env   (skips login, same session)"
echo "  token expires in 24h — source this script again tomorrow"

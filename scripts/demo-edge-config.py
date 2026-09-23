#!/usr/bin/env python3
"""
demo-edge-config.py — one-command Cloudflare edge configuration for the
PGC Bank security demo.

Subcommands:
  sync     Upload/refresh the OpenAPI schema and Endpoint Management ops.
  arm      Enable all "PGC demo:" protective rules + schema validation BLOCK
           (the demo's "after" state).
  disarm   Disable the demo rules + schema validation back to LOG (the
           pre-demo "before" state). This is the state to leave the zone in
           until you are live on stage.
  status   Print the current state of everything this script manages.

Usage:
  python scripts/demo-edge-config.py <sync|arm|disarm|status>

Requires CLOUDFLARE_API_TOKEN in the environment (already set on this machine)
and targets the puregroundscoffee.com zone. All rules this script owns are
recognised by the "PGC demo:" description prefix; nothing else on the zone is
touched. JWT validation rules (which need the JWT_SECRET pasted by hand) are
deliberately out of scope — see POC-ATTACK-GUIDE.html for that manual step.
"""
import json
import os
import re
import sys
import urllib.request

API = "https://api.cloudflare.com/client/v4"
ZONE_NAME = "puregroundscoffee.com"
HOST = "banking.puregroundscoffee.com"
RULE_PREFIX = "PGC demo:"
SCHEMA_FILE = os.path.join(os.path.dirname(__file__), "..", "openapi-schema.yaml")

TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")


def api(method, path, payload=None):
    url = f"{API}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req) as resp:
        body = json.loads(resp.read())
    if not body.get("success"):
        raise RuntimeError(f"{method} {path} failed: {body.get('errors')}")
    return body["result"]


def zone_id():
    return api("GET", f"/zones?name={ZONE_NAME}")[0]["id"]


# --- Schema validation -------------------------------------------------------

def sync_schema(z):
    source = open(SCHEMA_FILE, encoding="utf-8").read()
    existing = api("GET", f"/zones/{z}/schema_validation/schemas")
    match = [s for s in existing if s["name"] in ("openapi-schema", "openapi-schema.yaml", "pgc-bank-openapi")]
    if match:
        print(f"  schema '{match[0]['name']}' already uploaded ({match[0]['schema_id'][:8]}...) — leaving as-is")
    else:
        r = api("POST", f"/zones/{z}/schema_validation/schemas", {
            "kind": "openapi_v3",
            "name": "openapi-schema",
            "source": source,
            "validation_enabled": True,
        })
        print(f"  uploaded schema {r['schema_id'][:8]}... (validation_enabled)")


def sync_operations(z):
    """Register every legitimate operation in Endpoint Management (schema
    validation only acts on registered ops). Path params become {varN}."""
    import yaml  # pyyaml, already used to lint the schema
    doc = yaml.safe_load(open(SCHEMA_FILE, encoding="utf-8"))
    existing = {(o["method"], o["endpoint"]) for o in api("GET", f"/zones/{z}/api_gateway/operations")}
    wanted = []
    for path, item in doc["paths"].items():
        endpoint = re.sub(r"\{[^}]+\}", "{var1}", path)
        for method in item:
            if (method.upper(), endpoint) not in existing:
                wanted.append({"method": method.upper(), "host": HOST, "endpoint": endpoint})
    added = 0
    # The API expects an array of entities; post in chunks of 20.
    for i in range(0, len(wanted), 20):
        chunk = wanted[i:i + 20]
        try:
            api("POST", f"/zones/{z}/api_gateway/operations", chunk)
            added += len(chunk)
        except Exception as e:
            print(f"    (warning) chunk of {len(chunk)} failed: {e}")
    print(f"  Endpoint Management synced ({added} added, {len(existing)} already present)")


def set_validation_action(z, action):
    api("PUT", f"/zones/{z}/schema_validation/settings", {
        "validation_default_mitigation_action": action,
        "validation_override_mitigation_action": None,
    })
    print(f"  schema validation default action = {action}")


def validation_action(z):
    return api("GET", f"/zones/{z}/schema_validation/settings").get(
        "validation_default_mitigation_action", "none")


# Leaked Credentials detection (the successor to the deprecated Exposed
# Credentials Check managed ruleset, removed from this zone 2026-09-22).
# The zone-level detection (Security -> Settings -> Detection tools) stays
# ON permanently like SDD — it only populates fields, never blocks. The
# before/after flip comes from the custom "log" rule in CUSTOM_RULES below,
# which records detected logins to Security Events only when armed.
def leaked_creds_status(z):
    try:
        r = api("GET", f"/zones/{z}/leaked-credential-checks")
        state = "on" if r.get("enabled") else "off"
    except Exception as e:
        print(f"  [??] leaked credential detection unreadable: {e}")
        return
    print(f"  [{state}] Leaked credential detection (zone detection, detect-only — leave on)")
    if not r.get("enabled"):
        print("       ^ expected ON: Security -> Settings -> Detection tools -> Leaked credential detection")


# Cloudflare Sensitive Data Detection managed ruleset (response-body scan).
# Deployed via the dashboard (Security -> Data -> Sensitive Data Detection);
# it is NOT prefixed "PGC demo:" and this tool never modifies it — it is a
# log/detect-only scan, safe to leave on in both demo states. status
# merely detects and reports it.
SDD_RULESET_ID = "e22d83c647c64a3eae91b71b499d988e"


def _rule_executes(r, ruleset_id):
    return r.get("action") == "execute" and \
        r.get("action_parameters", {}).get("id") == ruleset_id


def sdd_status(z):
    existing = get_ruleset(z, "http_response_firewall_managed")
    found = [r for r in (existing["rules"] if existing else []) if _rule_executes(r, SDD_RULESET_ID)]
    if not found:
        print("  [??] Sensitive Data Detection NOT deployed — enable via dashboard: Security -> Data -> Sensitive Data Detection -> Managed ruleset")
    for r in found:
        print(f"  [{'on' if r.get('enabled') else 'off'}] Sensitive Data Detection ruleset (dashboard-managed, detect-only — leave on)")


# --- Custom + rate-limit rules ----------------------------------------------
# Both phases: fetch the entrypoint ruleset (creating it if needed), keep any
# rules that are not ours, and write back our rules with the desired state.

CUSTOM_RULES = [
    {
        "description": f"{RULE_PREFIX} fallthrough block (ops outside the OpenAPI schema)",
        "expression": f'(http.host eq "{HOST}" and http.request.uri.path matches "^/api/" and cf.api_gateway.fallthrough_detected)',
        "action": "block",
        "enabled": True,
    },
    {
        # Parentheses around the not(...) clause are load-bearing: removing
        # them rebinds the `not` and INVERTS the rule (verified 2026-09-23 —
        # unparenthesized form blocked Bearer logins and let no-auth through).
        # The dashboard visual builder may not round-trip this expression; if
        # it needs to be shown in builder view, recreate the rule once via the
        # builder UI (Hostname = host, URI Path = path, Request header
        # authorization does not contain "Bearer ") — builder-authored rules
        # stay builder-editable.
        "description": f"{RULE_PREFIX} block unauthenticated /api/internal/debug",
        "expression": f'(http.host eq "{HOST}" and http.request.uri.path eq "/api/internal/debug" and not (http.request.headers["authorization"][0] contains "Bearer "))',
        "action": "block",
        "enabled": True,
    },
    {
        "description": f"{RULE_PREFIX} block malicious uploads (content scanning)",
        "expression": f'(http.host eq "{HOST}" and cf.waf.content_scan.has_malicious_obj and http.request.uri.path eq "/api/uploads")',
        "action": "block",
        "enabled": True,
    },
    {
        # Schema validation matches on declared parameters but does not reject
        # undeclared query params, so the API3 "after" block is a plain custom
        # rule: /api/profile has no contract for a query string at all.
        "description": f"{RULE_PREFIX} block any query string on /api/profile",
        "expression": f'(http.host eq "{HOST}" and http.request.uri.path eq "/api/profile" and http.request.uri.query ne "")',
        "action": "block",
        "enabled": True,
    },
]

RATE_LIMIT_RULES = [
    {
        # Counts per Authorization header value (= per logged-in session) —
        # upgraded to advanced characteristics in the dashboard 2026-09-23.
        "description": f"{RULE_PREFIX} express-transfer burst rate limit",
        "expression": f'(http.host eq "{HOST}" and http.request.uri.path eq "/api/transfers/express")',
        "action": "block",
        "enabled": True,
        "ratelimit": {
            "characteristics": ['http.request.headers["authorization"]', "cf.colo.id"],
            "requests_to_origin": False,
            "requests_per_period": 10,
            "period": 60,
            "mitigation_timeout": 120,
        },
    },
    {
        # Also upgraded to per-session counting (operator, dashboard,
        # 2026-09-23) — both UC-4 rules key on the Authorization header.
        "description": f"{RULE_PREFIX} loan/investment spam rate limit",
        "expression": f'(http.host eq "{HOST}" and http.request.method eq "POST" and (http.request.uri.path eq "/api/loans/apply" or http.request.uri.path eq "/api/investments"))',
        "action": "block",
        "enabled": True,
        "ratelimit": {
            "characteristics": ['http.request.headers["authorization"]', "cf.colo.id"],
            "requests_to_origin": False,
            "requests_per_period": 5,
            "period": 60,
            "mitigation_timeout": 120,
        },
    },
]


def get_ruleset(z, phase):
    try:
        return api("GET", f"/zones/{z}/rulesets/phases/{phase}/entrypoint")
    except Exception:
        return None


def put_ruleset(z, phase, rules):
    # The phase entrypoint endpoint creates-or-replaces; kind/phase are not
    # accepted fields there.
    return api("PUT", f"/zones/{z}/rulesets/phases/{phase}/entrypoint", {
        "name": "default", "rules": rules,
    })


def apply_rules(z, phase, ours, enabled):
    existing = get_ruleset(z, phase)
    current = existing["rules"] if existing else []
    keep = [r for r in current if not r.get("description", "").startswith(RULE_PREFIX)]
    merged = keep + [{**r, "enabled": enabled} for r in ours]
    put_ruleset(z, phase, merged)
    state = "armed" if enabled else "disarmed"
    for r in ours:
        print(f"  {state}: {r['description']}")


# --- Main -------------------------------------------------------------------- 

def main():
    if not TOKEN:
        sys.exit("CLOUDFLARE_API_TOKEN is not set")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    z = zone_id()
    print(f"zone {ZONE_NAME} ({z}), host {HOST}")

    if cmd == "sync":
        print("syncing schema + operations:")
        sync_schema(z)
        set_validation_action(z, "log")
        sync_operations(z)
    elif cmd == "arm":
        print("arming protections (demo AFTER state):")
        apply_rules(z, "http_request_firewall_custom", CUSTOM_RULES, True)
        apply_rules(z, "http_ratelimit", RATE_LIMIT_RULES, True)
        leaked_creds_status(z)
        sdd_status(z)
        set_validation_action(z, "block")
    elif cmd == "disarm":
        print("disarming protections (demo BEFORE / staging state):")
        apply_rules(z, "http_request_firewall_custom", CUSTOM_RULES, False)
        apply_rules(z, "http_ratelimit", RATE_LIMIT_RULES, False)
        leaked_creds_status(z)
        sdd_status(z)
        set_validation_action(z, "log")
    elif cmd == "status":
        print(f"  schema validation default action: {validation_action(z)}")
        for phase in ("http_request_firewall_custom", "http_ratelimit"):
            rs = get_ruleset(z, phase)
            ours = [r for r in (rs["rules"] if rs else []) if r.get("description", "").startswith(RULE_PREFIX)]
            for r in ours:
                print(f"  [{'on' if r.get('enabled') else 'off'}] {r['description']}")
            if not ours:
                print(f"  (no demo rules in {phase})")
        leaked_creds_status(z)
        # The operator maintains an unscoped "Leaked Credentials Rule" custom
        # rule (added 2026-09-22) that blocks leaked creds zone-wide in ALL
        # demo states. It is not PGC-prefixed; report it, never toggle it.
        rs = get_ruleset(z, "http_request_firewall_custom")
        for r in (rs["rules"] if rs else []):
            if "credential_check" in r.get("expression", "") and \
               not r.get("description", "").startswith(RULE_PREFIX):
                print(f"  [{'on' if r.get('enabled', True) else 'off'}] {r['description']} (user-owned leaked-credentials mitigation — always on)")
        sdd_status(z)
    else:
        sys.exit(f"unknown command: {cmd}")


if __name__ == "__main__":
    main()

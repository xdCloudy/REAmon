#!/usr/bin/env bash
# =============================================================================
# The inbound MCP endpoint's nginx location.
# Run:  bash tests/deploy_mcp_nginx_test.sh
#
# Two traps this pins, both of which fail SILENTLY in production:
#
# 1. EXACT MATCH. A prefix block written `location /api/mcp-server/ {` does NOT
#    match the endpoint URL `/api/mcp-server`. The request would fall through to
#    `location /api/` and get the UI rate zone plus - under
#    GATE_MODE=basic_auth - a gate that eats the Authorization header the
#    client needs. Nothing errors; MCP just stops working, or works with the
#    wrong limits.
#
# 2. HEADER INHERITANCE. A location carrying ANY add_header does not inherit the
#    server-level ones, so HSTS/CSP and Cache-Control are lost unless re-emitted.
#    The template already records this trap on the login location; this endpoint
#    has the same shape.
#
# Plus the §14.2 decision: under basic_auth the endpoint is CLOSED by default,
# because Basic and Bearer cannot both travel in one Authorization header.
#
# The rendered configs are validated with a real `nginx -t` when Docker is
# available, and skipped cleanly when it is not.
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$REPO_ROOT/tooling/deploy/single-host"
TMPL="$DEPLOY/nginx/redamon.conf.tmpl"
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s (got: %s want: %s)\n' "$1" "$2" "$3"; }
skip() { SKIP=$((SKIP+1)); printf '  skip %s (%s)\n' "$1" "$2"; }
eq()   { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }

# render <GATE_MODE> [MCP_EDGE_ALLOW_BEARER] [MCP_CLIENT_CIDRS] [TEMPLATE]
render() {
    ( cd "$REPO_ROOT" && \
      GATE_MODE="$1" MCP_EDGE_ALLOW_BEARER="${2:-false}" \
      MCP_CLIENT_CIDRS="${3:-}" MCP_SERVER_ENABLED=true \
      OPERATOR_ALLOW_CIDRS="1.2.3.4/32" \
      SERVER_NAME=redamon.example SSL_CERT_REMOTE=/c.pem SSL_KEY_REMOTE=/k.pem \
      CSP_CONNECT="'self'" CSP_HEADER_NAME=Content-Security-Policy \
      WS_AUTH_REQUEST="" REDIRECT_HOST=redamon.example TLS_MODE=selfsigned \
      _NGINX_MOD="$DEPLOY/modules/nginx.sh" _TMPL="${4:-$TMPL}" \
      bash -c '
        set -uo pipefail
        is_true() { [[ "$(printf "%s" "${1:-}" | tr "[:upper:]" "[:lower:]")" == "true" || "${1:-}" == "1" ]]; }
        source "$_NGINX_MOD"
        _render_template "$_TMPL"
      ' 2>/dev/null )
}

# The body of the exact-match MCP location, for content assertions.
mcp_block() {
    awk '/location = \/api\/mcp-server \{/{f=1} f{print} f&&/^    \}/{exit}'
}

echo "== the location is an EXACT match, not a prefix =="
IP_CONF="$(render ip_allowlist)"
if grep -qF 'location = /api/mcp-server {' <<<"$IP_CONF"; then
    ok "location = /api/mcp-server (exact)"
else
    bad "location = /api/mcp-server (exact)" "absent" "an exact-match block"
fi
# A trailing-slash prefix block would not match the endpoint URL at all.
if grep -qE 'location +/api/mcp-server/ *\{' <<<"$IP_CONF"; then
    bad "no trailing-slash prefix block" "present" "absent"
else
    ok "no trailing-slash prefix block"
fi

echo
echo "== it has its own rate zone, not the UI's =="
if grep -qE 'limit_req_zone .* zone=mcp:' <<<"$IP_CONF"; then
    ok "a dedicated 'mcp' limit_req_zone is declared"
else
    bad "a dedicated 'mcp' limit_req_zone is declared" "absent" "zone=mcp"
fi
BLOCK="$(mcp_block <<<"$IP_CONF")"
if grep -qF 'limit_req zone=mcp' <<<"$BLOCK"; then
    ok "the location uses zone=mcp"
else
    bad "the location uses zone=mcp" "$(grep -o 'zone=[a-z]*' <<<"$BLOCK" | head -1)" "zone=mcp"
fi
if grep -qF 'zone=api' <<<"$BLOCK"; then
    bad "the location does NOT use the UI zone" "zone=api" "zone=mcp only"
else
    ok "the location does NOT use the UI zone"
fi

echo
echo "== security headers are re-emitted (they are NOT inherited) =="
# DELIVERED, not "written here": a header counts whether the block states it
# directly (HSTS/CSP/Cache-Control, which are per-template) or inherits it from
# the shared snippet it includes. Asserting the literal would have forced the
# hand-copied list back, which is the drift this snippet exists to end.
HDRS_FILE="$DEPLOY/nginx/snippets/security-headers-only.conf"
delivers() {  # delivers <block> <header>
    grep -qF "add_header $2" <<<"$1" && return 0
    grep -qF 'redamon-security-headers-only.conf' <<<"$1" \
        && grep -qF "add_header $2" "$HDRS_FILE"
}
for hdr in Strict-Transport-Security X-Frame-Options X-Content-Type-Options \
           Referrer-Policy X-Robots-Tag Permissions-Policy \
           Cross-Origin-Opener-Policy Cross-Origin-Resource-Policy Cache-Control; do
    if delivers "$BLOCK" "$hdr"; then
        ok "$hdr delivered on /api/mcp-server"
    else
        bad "$hdr delivered on /api/mcp-server" "absent" "stated or included"
    fi
done
if grep -qF 'no-store' <<<"$BLOCK"; then
    ok "Cache-Control is no-store"
else
    bad "Cache-Control is no-store" "absent" "no-store"
fi

echo
echo "== long-lived proxy settings match location /api/ =="
grep -qF 'proxy_read_timeout 3600s' <<<"$BLOCK" && ok "proxy_read_timeout 3600s" \
    || bad "proxy_read_timeout 3600s" "absent" "3600s"
grep -qF 'proxy_buffering off' <<<"$BLOCK" && ok "proxy_buffering off" \
    || bad "proxy_buffering off" "absent" "off"

echo
echo "== the gate decision (plan 14.2): closed by default under basic_auth =="
BASIC_BLOCK="$(render basic_auth | mcp_block)"
if grep -qF 'return 403;' <<<"$BASIC_BLOCK"; then
    ok "basic_auth alone -> 403 (Basic and Bearer cannot share the header)"
else
    bad "basic_auth alone -> 403" "no return 403" "return 403"
fi
BEARER_BLOCK="$(render basic_auth true | mcp_block)"
if grep -qF 'auth_basic off;' <<<"$BEARER_BLOCK"; then
    ok "MCP_EDGE_ALLOW_BEARER=true -> auth_basic off"
else
    bad "MCP_EDGE_ALLOW_BEARER=true -> auth_basic off" "absent" "auth_basic off"
fi
if grep -qF 'return 403;' <<<"$BEARER_BLOCK"; then
    bad "the opt-in removes the 403" "still 403" "no 403"
else
    ok "the opt-in removes the 403"
fi
if grep -qE 'return 403|auth_basic' <<<"$BLOCK"; then
    bad "ip_allowlist inherits the server gate unchanged" "overridden" "inherited"
else
    ok "ip_allowlist inherits the server gate unchanged"
fi

echo
echo "== the rendered config is valid nginx =="
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    skip "nginx -t on the rendered config" "docker unavailable"
else
    # The scratchpad is not bind-mountable, so stage inside the repo.
    WORK="$REPO_ROOT/.mcp-nginx-check.$$"
    mkdir -p "$WORK/snip"
    render ip_allowlist            > "$WORK/r_ip.conf"
    render basic_auth              > "$WORK/r_basic.conf"
    render basic_auth true         > "$WORK/r_bearer.conf"
    # The CIDR gate emits allow/deny directives the other renders never produce,
    # so a malformed list is a parse error only this variant would catch.
    render ip_allowlist false "198.51.100.0/24,203.0.113.0/24" > "$WORK/r_cidr.conf"
    # The plaintext vhost: no test in this repo ever handed it to nginx, which
    # is exactly how it shipped with no MCP location at all.
    render ip_allowlist false "" "$DEPLOY/nginx/redamon-http.conf.tmpl" > "$WORK/r_http.conf"
    _VARIANTS="r_ip r_basic r_bearer r_cidr r_http"
    # Mirror what modules/nginx.sh does on the host: EVERY snippet, prefixed.
    # Naming them individually here is what hid the missing install of
    # security-headers-only.conf, which nginx -t treats as fatal.
    for _s in "$DEPLOY"/nginx/snippets/*.conf; do
        cp "$_s" "$WORK/snip/redamon-$(basename "$_s")"
    done
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/k.pem" -out "$WORK/c.pem" \
        -days 1 -subj "/CN=test" >/dev/null 2>&1

    # Guard against a false pass: nginx -t succeeds on an EMPTY conf.d, so a
    # render that silently produced nothing would look green. Prove each file
    # actually carries the block under test before trusting the parse.
    for f in $_VARIANTS; do
        if grep -qF 'location = /api/mcp-server {' "$WORK/$f.conf"; then
            ok "$f rendered a real config"
        else
            bad "$f rendered a real config" "empty or missing the MCP block" "a rendered vhost"
        fi
    done

    OUT="$(docker run --rm -v "$WORK:/s:ro" --entrypoint sh nginx:alpine -c '
        mkdir -p /etc/nginx/snippets && cp /s/snip/*.conf /etc/nginx/snippets/
        cp /s/c.pem /c.pem && cp /s/k.pem /k.pem
        mkdir -p /var/www/certbot; touch /etc/nginx/.redamon_htpasswd
        for f in '"$_VARIANTS"'; do
            cp /s/$f.conf /etc/nginx/conf.d/redamon.conf
            if nginx -t 2>&1 | grep -q "test is successful"; then echo "$f OK";
            else echo "$f FAIL: $(nginx -t 2>&1 | grep emerg | head -1)"; fi
            rm -f /etc/nginx/conf.d/redamon.conf
        done' 2>/dev/null)"
    rm -rf "$WORK"

    for f in $_VARIANTS; do
        if grep -qF "$f OK" <<<"$OUT"; then
            ok "nginx -t passes ($f)"
        else
            bad "nginx -t passes ($f)" "$(grep -F "$f" <<<"$OUT")" "test is successful"
        fi
    done
fi

echo
echo "== the HTTP template has the block too (it had NONE) =="
# redamon-http.conf.tmpl was rendered by no test in the repo, which is how it
# shipped with no mcp zone and no location at all: a request to /api/mcp-server
# fell through to `location /api/` on the UI rate zone, behind a gate that eats
# the Authorization header. deploy.sh now REFUSES MCP in http-* modes, but the
# template must still be correct if the flag is ever set by hand on the host.
HTTP_TMPL="$DEPLOY/nginx/redamon-http.conf.tmpl"
HTTP_CONF="$(render ip_allowlist false "" "$HTTP_TMPL")"
if grep -qF 'location = /api/mcp-server {' <<<"$HTTP_CONF"; then
    ok "http template has the exact-match location"
else
    bad "http template has the exact-match location" "absent" "an exact-match block"
fi
if grep -qE 'limit_req_zone .* zone=mcp:' <<<"$HTTP_CONF"; then
    ok "http template declares its own mcp zone"
else
    bad "http template declares its own mcp zone" "absent" "zone=mcp"
fi
HTTP_BLOCK="$(mcp_block <<<"$HTTP_CONF")"
grep -qF 'zone=mcp' <<<"$HTTP_BLOCK" && ok "http location uses zone=mcp, not the UI zone" \
    || bad "http location uses zone=mcp" "zone=api or none" "zone=mcp"
# No HSTS in the plaintext template: claiming it there would be a lie.
if grep -qF 'Strict-Transport-Security' <<<"$HTTP_BLOCK"; then
    bad "http location does NOT claim HSTS" "present" "absent"
else
    ok "http location does NOT claim HSTS (it is the plaintext template)"
fi

echo
echo "== the shared headers snippet, not a hand-copied list =="
# Hand-copying is what let the login block drift (it lost Permissions-Policy,
# COOP and CORP). The MCP block includes the shared file instead, which also
# proves nginx accepts it inside a location (the full security-headers.conf
# cannot be included there: it ends with `location ~` blocks).
for label in "https:$BLOCK" "http:$HTTP_BLOCK"; do
    name="${label%%:*}"; body="${label#*:}"
    grep -qF 'redamon-security-headers-only.conf' <<<"$body" \
        && ok "$name location includes the shared headers snippet" \
        || bad "$name location includes the shared headers snippet" "hand-copied or absent" "include"
done
HDRS="$DEPLOY/nginx/snippets/security-headers-only.conf"
if grep -qE '^location ' "$HDRS"; then
    bad "the headers-only snippet has no location blocks" "has one" "none"
else
    ok "the headers-only snippet has no location blocks (includable in a location)"
fi
for h in Permissions-Policy Cross-Origin-Opener-Policy Cross-Origin-Resource-Policy; do
    grep -qF "add_header $h" "$HDRS" && ok "$h is in the shared set" \
        || bad "$h is in the shared set" "absent" "present"
done

echo
echo "== the body cap and the rate-limit log level =="
for label in "https:$BLOCK" "http:$HTTP_BLOCK"; do
    name="${label%%:*}"; body="${label#*:}"
    grep -qF 'client_max_body_size 64k' <<<"$body" \
        && ok "$name location caps MCP requests at 64k (server has no body-size cap)" \
        || bad "$name location caps MCP requests at 64k" "inherits no cap" "64k"
    # At [error] level the stock nginx-limit-req fail2ban jail bans a bursty but
    # legitimate MCP client, taking the operator's IP with it.
    grep -qF 'limit_req_log_level warn' <<<"$body" \
        && ok "$name location logs rate-limiting at warn (fail2ban safe)" \
        || bad "$name location logs rate-limiting at warn" "error (fail2ban bans)" "warn"
done

echo
echo "== MCP_CLIENT_CIDRS admits an agent WITHOUT widening the UI =="
# The firewall opens the PORT to these sources; the location is what narrows
# them to this one path. allow/deny in a location REPLACES the inherited set.
CIDR_BLOCK="$(render ip_allowlist false "198.51.100.0/24" | mcp_block)"
grep -qF 'allow 198.51.100.0/24;' <<<"$CIDR_BLOCK" && ok "the agent CIDR is allowed on the MCP path" \
    || bad "the agent CIDR is allowed on the MCP path" "absent" "allow 198.51.100.0/24"
grep -qF 'allow 1.2.3.4/32;' <<<"$CIDR_BLOCK" && ok "the operator CIDR is re-stated (replace, not merge)" \
    || bad "the operator CIDR is re-stated" "absent" "allow 1.2.3.4/32"
grep -qF 'deny all;' <<<"$CIDR_BLOCK" && ok "everything else is denied on the MCP path" \
    || bad "everything else is denied" "absent" "deny all"
# The UI must NOT gain the agent CIDR.
UI_CONF="$(render ip_allowlist false "198.51.100.0/24")"
UI_GATE="$(awk '/# __GATE__/{next} /location \/ \{/{f=1} f{print}' <<<"$UI_CONF" | head -20)"
if grep -qF '198.51.100.0/24' <<<"$(sed '/location = \/api\/mcp-server/,/^    }/d' <<<"$UI_CONF")"; then
    bad "the agent CIDR does not leak outside the MCP location" "present elsewhere" "MCP location only"
else
    ok "the agent CIDR does not leak outside the MCP location"
fi

echo
printf 'passed %d, failed %d, skipped %d\n' "$PASS" "$FAIL" "$SKIP"
[[ "$FAIL" -eq 0 ]]

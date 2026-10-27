#!/usr/bin/env bash
# nginx.sh -- render the single-origin vhost from a template, install it, gate on
# `nginx -t`, reload (§6). Requires _common.sh.
#
# Reads (exported by deploy.sh): ACCESS_MODE, SERVER_NAME, CSP_CONNECT, TLS_MODE,
#   SSL_CERT_REMOTE, SSL_KEY_REMOTE, GATE_MODE, OPERATOR_ALLOW_CIDRS,
#   BASIC_AUTH_USER, BASIC_AUTH_PASS, MCP_EDGE_ALLOW_BEARER.
# Templates + snippet are SCP'd to /tmp/redamon-deploy/nginx/ by deploy.sh.

NGINX_TMPL_DIR=/tmp/redamon-deploy/nginx
NGINX_SITE=/etc/nginx/sites-available/redamon

# Build the access-gate directive block from GATE_MODE.
_gate_block() {
  case "${GATE_MODE:-ip_allowlist}" in
    ip_allowlist)
      local cidr out=""
      if [[ -z "${OPERATOR_ALLOW_CIDRS:-}" ]]; then
        echo "    # ip_allowlist selected but OPERATOR_ALLOW_CIDRS empty -> allow all (check .env)"
        return
      fi
      IFS=',' read -ra arr <<< "${OPERATOR_ALLOW_CIDRS}"
      for cidr in "${arr[@]}"; do
        cidr="$(echo "$cidr" | xargs)"; [[ -z "$cidr" ]] && continue
        out+="    allow ${cidr};"$'\n'
      done
      out+="    deny all;"
      printf '%s\n' "${out}"
      ;;
    basic_auth)
      printf '%s\n' '    auth_basic "RedAmon";
    auth_basic_user_file /etc/nginx/.redamon_htpasswd;'
      ;;
    none|*)
      echo "    # access gate: none (relying on app login + cloud Security Group)"
      ;;
  esac
}

# The access gate for the INBOUND MCP endpoint specifically.
#
# Two independent problems, both solved inside this one location:
#
# 1. GATE_MODE=basic_auth is MUTUALLY EXCLUSIVE with bearer auth. It emits
#    auth_basic on the whole :443 server, consuming the Authorization header,
#    and a client cannot send Basic and Bearer at once. So under basic_auth the
#    endpoint is 403 by DEFAULT; MCP_EDGE_ALLOW_BEARER=true turns auth_basic off
#    for this location only, leaving the PAT as its sole credential.
#
# 2. An external agent is not the operator. Under ip_allowlist the server-level
#    allow/deny admits only OPERATOR_ALLOW_CIDRS, which a cloud agent or CI
#    runner is not in. Re-stating allow/deny HERE (nginx replaces, never merges,
#    inherited allow/deny in a location) admits MCP_CLIENT_CIDRS to this ONE
#    path while the UI stays operator-only. The firewall must admit the same
#    CIDRs to the port, which _allow_mcp_clients does.
_mcp_gate_block() {
  local out=""
  # The CIDR clause is emitted for every gate mode: basic_auth still inherits
  # the server-level allow/deny when OPERATOR_ALLOW_CIDRS is set alongside it.
  if is_true "${MCP_SERVER_ENABLED:-false}" && [[ -n "${MCP_CLIENT_CIDRS:-}" ]]; then
    local cidr
    out+="        # MCP client CIDRs reach THIS path only; the UI stays operator-gated."$'\n'
    IFS=',' read -ra _mc <<< "${MCP_CLIENT_CIDRS}"
    for cidr in "${_mc[@]}"; do
      cidr="$(echo "$cidr" | xargs)"; [[ -z "$cidr" ]] && continue
      out+="        allow ${cidr};"$'\n'
    done
    if [[ -n "${OPERATOR_ALLOW_CIDRS:-}" ]]; then
      IFS=',' read -ra _oc <<< "${OPERATOR_ALLOW_CIDRS}"
      for cidr in "${_oc[@]}"; do
        cidr="$(echo "$cidr" | xargs)"; [[ -z "$cidr" ]] && continue
        out+="        allow ${cidr};"$'\n'
      done
      out+="        deny all;"$'\n'
    fi
  fi

  case "${GATE_MODE:-ip_allowlist}" in
    basic_auth)
      if is_true "${MCP_EDGE_ALLOW_BEARER:-false}"; then
        out+="        # MCP_EDGE_ALLOW_BEARER=true: the PAT is the only credential here."$'\n'
        out+="        auth_basic off;"$'\n'
      else
        out+="        # GATE_MODE=basic_auth consumes the Authorization header this"$'\n'
        out+="        # endpoint needs. Closed by default; set MCP_EDGE_ALLOW_BEARER=true."$'\n'
        out+="        return 403;"$'\n'
      fi
      ;;
    *)
      [[ -z "$out" ]] && out="        # Inherits the server-level access gate unchanged."$'\n'
      ;;
  esac
  printf '%s' "${out}"
}

_acme_block() {
  if [[ "${TLS_MODE:-}" == "letsencrypt" ]]; then
    echo "    location /.well-known/acme-challenge/ { root /var/www/certbot; }"
  else
    echo ""
  fi
}

_install_htpasswd() {
  [[ "${GATE_MODE:-}" == "basic_auth" ]] || return 0
  [[ -n "${BASIC_AUTH_USER:-}" && -n "${BASIC_AUTH_PASS:-}" ]] || { err "basic_auth needs BASIC_AUTH_USER/PASS"; return 1; }
  local hash
  hash=$(openssl passwd -apr1 "${BASIC_AUTH_PASS}")
  printf '%s:%s\n' "${BASIC_AUTH_USER}" "${hash}" | run_sudo_tee /etc/nginx/.redamon_htpasswd
  # Must be readable by the nginx worker (www-data on Debian/Ubuntu). 640 root:root left
  # www-data unable to open() it -> every credentialed request 500'd. Own it by the nginx
  # group so basic_auth actually authenticates.
  local ngx_grp; ngx_grp="$(id -gn "$(ps -o user= -C nginx 2>/dev/null | grep -v '^root$' | head -1)" 2>/dev/null)"
  [[ -n "${ngx_grp}" ]] || ngx_grp=www-data
  run_sudo chown "root:${ngx_grp}" /etc/nginx/.redamon_htpasswd
  run_sudo chmod 640 /etc/nginx/.redamon_htpasswd
}

# Line-oriented render: single-line tokens via bash substitution; whole-line blocks
# (__GATE__, __ACME_BLOCK__) replaced with their (possibly multi-line) content.
_render_template() {
  local tmpl="$1" gate mcp_gate acme line
  gate="$(_gate_block)"
  mcp_gate="$(_mcp_gate_block)"
  acme="$(_acme_block)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    case "$line" in
      *"# __MCP_GATE__"*) printf '%s\n' "${mcp_gate}" ;;
      *"# __GATE__"*)   printf '%s\n' "${gate}" ;;
      "__ACME_BLOCK__") printf '%s\n' "${acme}" ;;
      *Strict-Transport-Security*)
        # HSTS is https-only and operator-toggleable via HSTS_ENABLE.
        if is_true "${HSTS_ENABLE:-true}"; then printf '%s\n' "$line"; fi
        ;;
      *)
        line="${line//__SERVER_NAME__/${SERVER_NAME}}"
        line="${line//__SSL_CERT_REMOTE__/${SSL_CERT_REMOTE}}"
        line="${line//__SSL_KEY_REMOTE__/${SSL_KEY_REMOTE}}"
        line="${line//__CSP_CONNECT__/${CSP_CONNECT}}"
        line="${line//__HTTP_PORT__/${HTTP_PORT:-80}}"
        line="${line//__HTTPS_PORT__/${HTTPS_PORT:-443}}"
        line="${line//__CSP_HEADER_NAME__/${CSP_HEADER_NAME}}"
        line="${line//__WS_AUTH_REQUEST__/${WS_AUTH_REQUEST}}"
        line="${line//__REDIRECT_HOST__/${REDIRECT_HOST}}"
        printf '%s\n' "$line"
        ;;
    esac
  done < "$tmpl"
}

_install_snippet() {
  run_sudo mkdir -p /etc/nginx/snippets
  # Copy EVERY snippet, by glob. Naming them one by one is how a newly added
  # file gets left behind: security-headers.conf now `include`s
  # security-headers-only.conf, so a missed copy is not a degraded config but a
  # hard `nginx -t` failure and a dead edge.
  local _snip
  for _snip in "${NGINX_TMPL_DIR}"/snippets/*.conf; do
    [ -e "${_snip}" ] || continue
    run_sudo cp "${_snip}" "/etc/nginx/snippets/redamon-$(basename "${_snip}")"
  done
}

# Choose template by ACCESS_MODE and install the site (does NOT reload -- caller gates).
_write_site() {
  local tmpl
  case "${ACCESS_MODE:-https-domain}" in
    https-*) tmpl="${NGINX_TMPL_DIR}/redamon.conf.tmpl" ;;
    http-*)  tmpl="${NGINX_TMPL_DIR}/redamon-http.conf.tmpl" ;;
    *) err "Unknown ACCESS_MODE: ${ACCESS_MODE}"; return 1 ;;
  esac
  [[ -f "$tmpl" ]] || { err "template not found: $tmpl"; return 1; }
  # Derived render values (globals so _render_template sees them under bash dynamic scope).
  CSP_HEADER_NAME="Content-Security-Policy-Report-Only"
  is_true "${CSP_ENFORCE:-false}" && CSP_HEADER_NAME="Content-Security-Policy"
  WS_AUTH_REQUEST=""
  is_true "${WS_REQUIRE_SESSION:-true}" && WS_AUTH_REQUEST="auth_request /_redamon_session;"
  case "${ACCESS_MODE:-https-domain}" in
    *-domain) REDIRECT_HOST="${DOMAIN}" ;;
    *)        REDIRECT_HOST='$host' ;;   # bare-IP: keep nginx $host (no canonical name)
  esac
  info "nginx: CSP=${CSP_HEADER_NAME}, WS session gate=$([ -n "$WS_AUTH_REQUEST" ] && echo on || echo off)"
  _install_snippet
  _install_htpasswd
  _render_template "$tmpl" | run_sudo_tee "${NGINX_SITE}"
  run_sudo rm -f /etc/nginx/sites-enabled/default
  run_sudo ln -sf "${NGINX_SITE}" /etc/nginx/sites-enabled/redamon
}

_nginx_test_reload() {
  if ! run_sudo nginx -t; then
    err "nginx -t FAILED -- not reloading"
    return 1
  fi
  run_sudo systemctl reload nginx || run_sudo systemctl restart nginx
  success "nginx configuration valid and reloaded"
}

# --- letsencrypt phase A: a minimal HTTP server that serves the ACME webroot on 80,
#     so certbot certonly --webroot can validate before we have a cert. ---
nginx_install_acme_bootstrap() {
  step "nginx: ACME bootstrap (port 80 webroot)"
  run_sudo mkdir -p /var/www/certbot
  _install_snippet
  cat <<EOF | run_sudo_tee "${NGINX_SITE}"
server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_NAME};
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 200 'redamon acme bootstrap'; add_header Content-Type text/plain; }
}
EOF
  run_sudo rm -f /etc/nginx/sites-enabled/default
  run_sudo ln -sf "${NGINX_SITE}" /etc/nginx/sites-enabled/redamon
  _nginx_test_reload
}

# --- render + install the real single-origin site, then gate + reload. ---
nginx_render_and_install() {
  step "nginx: render single-origin site (${ACCESS_MODE})"
  _write_site
  _nginx_test_reload
}

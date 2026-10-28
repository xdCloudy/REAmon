#!/usr/bin/env bash
# =============================================================================
# Test suite for the secret-generation logic in redamon.sh
#   - ensure_auth_secrets  -> now also emits MCP_AUTH_TOKEN (STRIDE S10)
#   - ensure_db_secrets     -> fresh-install generation, live-DB rotation, and
#                              (issue #155) a hard STOP with remediation when a
#                              stale data volume can't be rotated off the default
#                              for POSTGRES_PASSWORD / NEO4J_PASSWORD (STRIDE S13)
#
# Pure unit tests: `docker` is stubbed, `.env` lives in a temp dir. No daemon
# needed, CI-friendly. Run:  bash tests/redamon_secrets_test.sh
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Source the script (BASH_SOURCE guard prevents command dispatch).
# shellcheck disable=SC1090
source "$REPO_ROOT/redamon.sh"
set +e

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); printf '  \033[0;32mPASS\033[0m %s\n' "$1"; }
fail() { FAIL=$((FAIL+1)); printf '  \033[0;31mFAIL\033[0m %s\n' "$1"; }
assert_true()  { if eval "$2"; then pass "$1"; else fail "$1 (cmd: $2)"; fi; }
assert_false() { if eval "$2"; then fail "$1 (cmd unexpectedly true: $2)"; else pass "$1"; fi; }
assert_eq()    { if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1 (got='$2' expected='$3')"; fi; }

# Redirect the script's own info/warn chatter into a capture file per test.
LOGCAP=""
run_capturing() { LOGCAP="$("$@" 2>&1)"; }

echo "== ensure_auth_secrets: MCP_AUTH_TOKEN =="
TMP=$(mktemp -d); SCRIPT_DIR="$TMP"
ensure_auth_secrets >/dev/null 2>&1
assert_true  "MCP_AUTH_TOKEN generated (64 hex)" "grep -qE '^MCP_AUTH_TOKEN=[0-9a-f]{64}\$' '$TMP/.env'"
assert_true  "AUTH_SECRET still generated"        "grep -qE '^AUTH_SECRET=[0-9a-f]{64}\$' '$TMP/.env'"
# STRIDE S6 + I19: the WS-ticket signing secret and tunnel auth token.
assert_true  "AGENT_WS_TICKET_SECRET generated (64 hex)" "grep -qE '^AGENT_WS_TICKET_SECRET=[0-9a-f]{64}\$' '$TMP/.env'"
assert_true  "TUNNEL_AUTH_TOKEN generated (64 hex)"      "grep -qE '^TUNNEL_AUTH_TOKEN=[0-9a-f]{64}\$' '$TMP/.env'"
# STRIDE S3/E6: the scoped scanner token.
assert_true  "SCANNER_API_KEY generated (64 hex)"        "grep -qE '^SCANNER_API_KEY=[0-9a-f]{64}\$' '$TMP/.env'"
# S3/E6: it must be DISTINCT from the master INTERNAL_API_KEY (the whole point).
assert_true  "SCANNER_API_KEY != INTERNAL_API_KEY" "[ \"\$(sed -n 's/^SCANNER_API_KEY=//p' '$TMP/.env')\" != \"\$(sed -n 's/^INTERNAL_API_KEY=//p' '$TMP/.env')\" ]"
# Idempotency: second call must not duplicate.
ensure_auth_secrets >/dev/null 2>&1
assert_eq    "MCP_AUTH_TOKEN not duplicated" "$(grep -c '^MCP_AUTH_TOKEN=' "$TMP/.env")" "1"
assert_eq    "AGENT_WS_TICKET_SECRET not duplicated" "$(grep -c '^AGENT_WS_TICKET_SECRET=' "$TMP/.env")" "1"
assert_eq    "TUNNEL_AUTH_TOKEN not duplicated" "$(grep -c '^TUNNEL_AUTH_TOKEN=' "$TMP/.env")" "1"
assert_eq    "SCANNER_API_KEY not duplicated" "$(grep -c '^SCANNER_API_KEY=' "$TMP/.env")" "1"
rm -rf "$TMP"

# test_ensure_auth_secrets_survives_set_e (issue #157)
# The REAL script runs under `set -euo pipefail`; this harness relaxes it to
# `set +e` (line ~20), so a `var="$(grep ... )"` that fails on a no-match was
# invisible here while it silently killed `./redamon.sh install` on any FRESH
# install right after the auth tokens (the new `.env` has no POSTGRES_DB line,
# so the TRAFFIC_INGEST_DATABASE_URL grep exited 1 -> pipefail -> set -e abort,
# before a single container was built). Re-enable `set -e` for this one call to
# lock the regression: it must reach the end AND emit the ingest DSN.
echo "== ensure_auth_secrets: fresh .env survives set -euo pipefail (#157) =="
TMP=$(mktemp -d); SCRIPT_DIR="$TMP"; : > "$TMP/.env"   # fresh, no POSTGRES_DB
( set -euo pipefail; ensure_auth_secrets ) >/dev/null 2>&1; rc=$?
assert_eq    "install path does NOT abort under set -e" "$rc" "0"
assert_true  "TRAFFIC_INGEST_DATABASE_URL still emitted" "grep -qE '^TRAFFIC_INGEST_DATABASE_URL=postgresql://traffic_ingest:[0-9a-f]{64}@postgres:5432/redamon\$' '$TMP/.env'"
# _env_get must never return non-zero, even on a missing key / missing file.
( set -e; _env_get NOPE "$TMP/.env" ) >/dev/null 2>&1; assert_eq "_env_get exits 0 on missing key" "$?" "0"
( set -e; _env_get NOPE "$TMP/does-not-exist" ) >/dev/null 2>&1; assert_eq "_env_get exits 0 on missing file" "$?" "0"
rm -rf "$TMP"

echo "== ensure_db_secrets: FRESH install (no data volume) =="
TMP=$(mktemp -d); SCRIPT_DIR="$TMP"
docker() { return 1; }   # volume inspect always fails -> fresh
ensure_db_secrets >/dev/null 2>&1
assert_true  "POSTGRES_PASSWORD generated (48 hex)" "grep -qE '^POSTGRES_PASSWORD=[0-9a-f]{48}\$' '$TMP/.env'"
assert_true  "NEO4J_PASSWORD generated (48 hex)"    "grep -qE '^NEO4J_PASSWORD=[0-9a-f]{48}\$' '$TMP/.env'"
# Idempotency on fresh: the line now exists -> no second append.
ensure_db_secrets >/dev/null 2>&1
assert_eq    "POSTGRES_PASSWORD not duplicated" "$(grep -c '^POSTGRES_PASSWORD=' "$TMP/.env")" "1"
unset -f docker; rm -rf "$TMP"

# test_ensure_db_secrets_rotates_existing_volume (STRIDE S13)
echo "== ensure_db_secrets: EXISTING volume on default -> rotate live DB + pin .env =="
TMP=$(mktemp -d); SCRIPT_DIR="$TMP"; : > "$TMP/.env"
# Stub: `docker volume inspect ...` -> exists (0); `docker ps` reports the DBs
# RUNNING (so the S13 rotation pre-step no-ops); `docker exec ...` (the ALTER)
# -> success (0). So rotation should ALTER then write the new strong value.
docker() { case "${1:-}" in volume) return 0;; ps) printf 'redamon-postgres\nredamon-neo4j\n'; return 0;; exec) return 0;; *) return 0;; esac; }
out="$(ensure_db_secrets 2>&1)"
assert_true  "POSTGRES_PASSWORD rotated + pinned (48 hex)" "grep -qE '^POSTGRES_PASSWORD=[0-9a-f]{48}\$' '$TMP/.env'"
assert_true  "NEO4J_PASSWORD rotated + pinned (48 hex)"    "grep -qE '^NEO4J_PASSWORD=[0-9a-f]{48}\$' '$TMP/.env'"
assert_true  "log mentions rotating"        "echo \"\$out\" | grep -qi 'Rotating'"
assert_true  "log confirms rotated"         "echo \"\$out\" | grep -qi 'Rotated'"
unset -f docker; rm -rf "$TMP"

# test_ensure_db_secrets_hardstop_on_alter_error (STRIDE S13 / issue #155)
# EXISTING volume whose password isn't the default: rotation off the default
# fails, so we must NOT write .env (split-brain) AND must NOT silently continue
# (the fail-closed ${VAR:?} guard would abort a later `up` with a cryptic error).
# Correct behaviour: exit non-zero with actionable remediation, volume untouched.
echo "== ensure_db_secrets: EXISTING volume, ALTER fails -> HARD STOP (#155) =="
TMP=$(mktemp -d); SCRIPT_DIR="$TMP"; : > "$TMP/.env"
# Stub: volume exists (0), DBs running (ps), but the ALTER (docker exec) FAILS (1).
docker() { case "${1:-}" in volume) return 0;; ps) printf 'redamon-postgres\nredamon-neo4j\n'; return 0;; exec) return 1;; *) return 0;; esac; }
before=$(md5sum "$TMP/.env" | awk '{print $1}')
# `exit 1` fires in the command-substitution subshell only, so the harness lives.
out="$(ensure_db_secrets 2>&1)"; rc=$?
after=$(md5sum "$TMP/.env" | awk '{print $1}')
# The listed volume names use the SANITISED compose project name (same helper
# the code resolves), not the raw temp-dir basename.
PROJ="$(compose_project_name)"
assert_eq    "exits non-zero (does not proceed to a doomed up)" "$rc" "1"
assert_eq    ".env unchanged when ALTER fails (no split-brain)" "$before" "$after"
assert_true  "still warns rotation FAILED"        "echo \"\$out\" | grep -qi 'rotation FAILED'"
assert_true  "error names both missing vars"      "echo \"\$out\" | grep -q 'POSTGRES_PASSWORD' && echo \"\$out\" | grep -q 'NEO4J_PASSWORD'"
assert_true  "remediation A: docker volume rm"    "echo \"\$out\" | grep -qi 'docker volume rm'"
assert_true  "remediation lists the volume names" "echo \"\$out\" | grep -q '${PROJ}_postgres_data' && echo \"\$out\" | grep -q '${PROJ}_neo4j_data'"
assert_true  "remediation B: pin password in .env" "echo \"\$out\" | grep -qi 'existing password'"
unset -f docker; rm -rf "$TMP"

# test_ensure_db_secrets_hardstop_mixed (issue #155)
# One var must fresh-generate (no volume) while the other can't be rotated
# (volume exists, ALTER fails). The generated one is written, but because the
# other is unresolved the whole call must still HARD STOP -- a half-set .env is
# still unstartable.
echo "== ensure_db_secrets: MIXED (one fresh, one rotate-fail) -> HARD STOP =="
TMP=$(mktemp -d); SCRIPT_DIR="$TMP"; : > "$TMP/.env"
# postgres volume EXISTS (rotate path, ALTER fails); neo4j volume ABSENT (fresh).
docker() {
  case "${1:-}" in
    volume) [[ "${3:-}" == *postgres_data ]] && return 0 || return 1 ;;
    ps) printf 'redamon-postgres\n'; return 0 ;;
    exec) return 1 ;;   # postgres ALTER fails
    *) return 0 ;;
  esac
}
out="$(ensure_db_secrets 2>&1)"; rc=$?
assert_eq    "mixed case still exits non-zero"    "$rc" "1"
assert_true  "NEO4J_PASSWORD was fresh-generated" "grep -qE '^NEO4J_PASSWORD=[0-9a-f]{48}\$' '$TMP/.env'"
assert_false "POSTGRES_PASSWORD not written (rotate failed)" "grep -q '^POSTGRES_PASSWORD=' '$TMP/.env'"
assert_true  "error names only the unresolved var" "echo \"\$out\" | grep -q 'Cannot configure the database password' && echo \"\$out\" | grep -q 'POSTGRES_PASSWORD'"
unset -f docker; rm -rf "$TMP"

# test_ensure_db_secrets_starts_stopped_db_for_rotation (STRIDE S13 / GAP B)
# The reboot->`up` and `down && update` path: default-cred volume exists but the
# DB is DOWN. The pre-step must START it (compose up, on the old default) so the
# ALTER can run, then pin the new value -- instead of failing on the fail-closed
# ${VAR:?} interpolation.
echo "== ensure_db_secrets: EXISTING volume, DB DOWN -> start it, then rotate =="
TMP=$(mktemp -d); SCRIPT_DIR="$TMP"; : > "$TMP/.env"
# Stub: volumes exist; `docker ps` returns NOTHING (DBs down); `docker compose up`
# succeeds; `docker inspect` health -> healthy; `docker exec` (ALTER) -> success.
docker() { case "${1:-}" in volume) return 0;; ps) return 0;; inspect) echo "healthy"; return 0;; compose) return 0;; exec) return 0;; *) return 0;; esac; }
out="$(ensure_db_secrets 2>&1)"
assert_true  "pre-step starts the stopped DB" "echo \"\$out\" | grep -qi 'Starting .* on current default creds'"
assert_true  "POSTGRES_PASSWORD rotated after auto-start" "grep -qE '^POSTGRES_PASSWORD=[0-9a-f]{48}\$' '$TMP/.env'"
assert_true  "NEO4J_PASSWORD rotated after auto-start"    "grep -qE '^NEO4J_PASSWORD=[0-9a-f]{48}\$' '$TMP/.env'"
unset -f docker; rm -rf "$TMP"

echo "== ensure_db_secrets: operator already pinned -> silent no-op =="
TMP=$(mktemp -d); SCRIPT_DIR="$TMP"
printf 'POSTGRES_PASSWORD=custompw\nNEO4J_PASSWORD=custompw2\n' > "$TMP/.env"
docker() { return 1; }   # even 'fresh' must be ignored when line present
before=$(md5sum "$TMP/.env" | awk '{print $1}')
out="$(ensure_db_secrets 2>&1)"
after=$(md5sum "$TMP/.env" | awk '{print $1}')
assert_eq    ".env unchanged when pinned" "$before" "$after"
assert_true  "no warning when pinned"     "[ -z \"\$(echo \"\$out\" | grep -i unset)\" ]"
unset -f docker; rm -rf "$TMP"

# NOTE: run assertions in the PARENT shell (no `( … )` subshells) — a subshell
# increments PASS/FAIL in its own copy and the tally is lost, so a broken
# assertion there would silently read as green. Isolate env vars manually.
echo "== compose_project_name honours override =="
COMPOSE_PROJECT_NAME="myproj"
assert_eq "override respected" "$(compose_project_name)" "myproj"
unset COMPOSE_PROJECT_NAME

# Regression (compose_project_name_from_env): COMPOSE_PROJECT_NAME set in .env
# (not exported) must be honoured, else ensure_db_secrets resolves the wrong
# volume name, mis-detects a fresh install, and could regenerate a password
# against a live DB.
echo "== compose_project_name reads .env (regression) =="
TMP=$(mktemp -d); SCRIPT_DIR="$TMP"
printf 'COMPOSE_PROJECT_NAME=envproj\n' > "$TMP/.env"
unset COMPOSE_PROJECT_NAME
assert_eq ".env project name honoured" "$(compose_project_name)" "envproj"
# And it must drive volume detection: stub docker to only 'find' envproj_*.
docker() {  # $3 is the volume name in: docker volume inspect <name>
    [[ "${3:-}" == "envproj_neo4j_data" || "${3:-}" == "envproj_postgres_data" ]] && return 0 || return 1
}
out="$(ensure_db_secrets 2>&1)"
# volume 'exists' under the .env project name -> must take the rotation path
# (not the fresh-generate path). The ALTER stub fails here (exec args don't
# match the volume names), so fail-safe leaves .env unwritten.
assert_true  "existing-volume detected via .env project name" "echo \"\$out\" | grep -qi 'Rotating\|on the existing'"
assert_false "no password blindly generated against live DB"  "grep -q '^POSTGRES_PASSWORD=' '$TMP/.env'"
unset -f docker; rm -rf "$TMP"

echo "== compose_project_name uses repository remote on transient mount paths =="
TMP=$(mktemp -d)
SCRIPT_DIR="$TMP/55a9ea805041122501e6139285a8c4fff16183d89d6b439e3205b3e130318b2d"
mkdir -p "$SCRIPT_DIR"
git -C "$SCRIPT_DIR" init -q
git -C "$SCRIPT_DIR" remote add origin https://github.com/xdCloudy/REAmon.git
unset COMPOSE_PROJECT_NAME
assert_eq "remote name is stable" "$(compose_project_name)" "reamon"
rm -rf "$TMP"

echo "== cmd_update: secrets generated BEFORE container recreate (S6/I19 stay enforced) =="
# Static ordering lock: within cmd_update(), ensure_auth_secrets must appear
# before the container recreate. If it regresses, a first update onto a release
# adding a new inbound secret would recreate containers with an empty value and
# fail those protections open until the next recreate.
SRC="$REPO_ROOT/redamon.sh"
u_start=$(grep -n '^cmd_update()' "$SRC" | head -1 | cut -d: -f1)
u_end=$(awk -v s="$u_start" 'NR>s && /^cmd_[a-z_]*\(\)/{print NR; exit}' "$SRC")
sec_line=$(awk -v s="$u_start" -v e="$u_end" 'NR>s && NR<e && /ensure_auth_secrets/{print NR; exit}' "$SRC")
rec_line=$(awk -v s="$u_start" -v e="$u_end" 'NR>s && NR<e && /docker compose up -d .*CORE_SERVICES/{print NR; exit}' "$SRC")
assert_true "ensure_auth_secrets present in cmd_update" "[[ -n '$sec_line' ]]"
assert_true "recreate present in cmd_update"            "[[ -n '$rec_line' ]]"
assert_true "secrets generated before recreate ($sec_line < $rec_line)" "[[ '$sec_line' -lt '$rec_line' ]]"

# test_compose_db_creds_failclosed (STRIDE S13): compose must use the ${VAR:?}
# fail-closed form (not ${VAR:-default}) for every DB password interpolation, so
# a stack cannot boot on the published constant.
echo "== docker-compose DB creds fail closed (no :-default) =="
COMPOSE="$REPO_ROOT/docker-compose.yml"
assert_false "no POSTGRES_PASSWORD :-redamon_secret default" "grep -q 'POSTGRES_PASSWORD:-redamon_secret' '$COMPOSE'"
assert_false "no NEO4J_PASSWORD :-changeme123 default"       "grep -q 'NEO4J_PASSWORD:-changeme123' '$COMPOSE'"
assert_eq    "POSTGRES_PASSWORD uses :? fail-closed (x2 consumers + db)" "$(grep -c 'POSTGRES_PASSWORD:?' "$COMPOSE")" "3"
assert_eq    "NEO4J_PASSWORD uses :? fail-closed (db + 4 consumers)"     "$(grep -c 'NEO4J_PASSWORD:?' "$COMPOSE")" "5"

# test_subcompose_neo4j_failclosed (issue #160): the per-service compose files
# used for standalone/dev runs must ALSO refuse the well-known changeme123
# fallback, so a bare `docker compose up` on any of them cannot silently init a
# volume with a default that later mismatches the rotated .env value.
echo "== sub-compose NEO4J_PASSWORD fail closed (no :-changeme123) =="
for sub in graph_db recon_orchestrator recon webapp agentic; do
    f="$REPO_ROOT/$sub/docker-compose.yml"
    assert_false "$sub: no NEO4J_PASSWORD :-changeme123 default" "grep -q 'NEO4J_PASSWORD:-changeme123' '$f'"
    assert_true  "$sub: NEO4J_PASSWORD uses :? fail-closed"      "grep -q 'NEO4J_PASSWORD:?' '$f'"
done

# test_kb_makefile_no_default_password (issue #160): the KB Makefile must not
# ship a changeme123 default; redamon.sh passes the real password via _kb_make.
echo "== KB Makefile has no insecure NEO4J_PASSWORD default =="
KBMK="$REPO_ROOT/services/knowledge_base/Makefile"
assert_false "KB Makefile: no 'NEO4J_PASSWORD ?= changeme123'" "grep -qE 'NEO4J_PASSWORD[[:space:]]*\?=[[:space:]]*changeme123' '$KBMK'"
assert_true  "KB Makefile: NEO4J_PASSWORD default is empty"    "grep -qE 'NEO4J_PASSWORD[[:space:]]*\?=[[:space:]]*\$' '$KBMK'"
assert_true  "KB Makefile: --neo4j-password value is quoted"   "[ \"\$(grep -c 'neo4j-password \"\$(NEO4J_PASSWORD)\"' '$KBMK')\" = 2 ]"
assert_true  "redamon.sh: _kb_make exports NEO4J_PASSWORD"     "grep -qE '_kb_make\(\)' '$REPO_ROOT/redamon.sh'"
assert_true  "redamon.sh: _kb_make sources NEO4J_PASSWORD from .env" "awk '/^_kb_make\\(\\)/{f=1} f&&/NEO4J_PASSWORD=.*_env_get NEO4J_PASSWORD/{print;exit}' '$REPO_ROOT/redamon.sh' | grep -q NEO4J_PASSWORD"

# test_reconcile_neo4j_password_present (issue #160): the pinned-.env branch of
# ensure_db_secrets must VERIFY the neo4j password against the live volume and
# reconcile, not trust it blindly (the silent-mismatch that produced #160).
echo "== redamon.sh neo4j reconcile preflight wired in =="
assert_true "redamon.sh: _reconcile_neo4j_password defined" "grep -q '^_reconcile_neo4j_password()' '$REPO_ROOT/redamon.sh'"
assert_true "redamon.sh: _neo4j_auth_ok defined"            "grep -q '^_neo4j_auth_ok()' '$REPO_ROOT/redamon.sh'"
assert_true "ensure_db_secrets calls _reconcile_neo4j_password on pinned .env" \
    "awk '/^ensure_db_secrets\\(\\)/{f=1} f&&/_reconcile_neo4j_password/{print;exit}' '$REPO_ROOT/redamon.sh' | grep -q _reconcile_neo4j_password"

# test_reconcile_neo4j_password_behaviour (issue #160): exercise the reconcile
# function against a stubbed Neo4j. `cypher-shell` succeeds only for the volume's
# CURRENT password ($GOODPW); rotation moves GOODPW to the requested new value.
echo "== _reconcile_neo4j_password behaviour (stubbed neo4j) =="
# Stubbed Neo4j state:
#   GOODPW        = password the "volume" currently accepts
#   LOCKED        = non-empty -> auth is rate-limited (fails for ANY pw); a
#                   `docker restart` clears it (mirrors the AuthenticationRateLimit
#                   lockout that #160 is really about).
#   NEO4J_RUNNING = whether `docker ps` reports the container up
#   COMPOSE_UP_RC = exit code of `docker compose up -d neo4j`
#   WAIT_RC       = exit code of _kb_wait_neo4j
#   ROTATE_CALLS  = number of times rotation was attempted (assert no needless rotate)
#   DOCKER_CALLS  = number of docker invocations (assert the empty-guard touches nothing)
GOODPW=""; LOCKED=""; NEO4J_RUNNING=1; COMPOSE_UP_RC=0; WAIT_RC=0; ROTATE_CALLS=0; DOCKER_CALLS=0; RESTART_RC=0
docker() {
    DOCKER_CALLS=$((DOCKER_CALLS+1))
    case "$1" in
        exec) # docker exec redamon-neo4j cypher-shell -u neo4j -p <PW> 'RETURN 1;'
            [[ -n "$LOCKED" ]] && return 1     # rate-limited: correct pw rejected too
            local pw="" prev="" a
            for a in "$@"; do [[ "$prev" == "-p" ]] && pw="$a"; prev="$a"; done
            [[ "$pw" == "$GOODPW" ]] && return 0 || return 1 ;;
        ps)      [[ -n "$NEO4J_RUNNING" ]] && printf 'redamon-neo4j\n'; return 0 ;;
        restart) LOCKED=""; return "$RESTART_RC" ;;  # restart clears the rate-limit lock
        compose) return "$COMPOSE_UP_RC" ;;    # `docker compose up -d neo4j`
        *)       return 0 ;;
    esac
}
_kb_wait_neo4j() { return "$WAIT_RC"; }
# rotation only works when handed the correct current password; it then moves
# the accepted password to the new value (mirrors ALTER CURRENT USER).
_rotate_neo4j_password() { ROTATE_CALLS=$((ROTATE_CALLS+1)); if [[ "$1" == "$GOODPW" ]]; then GOODPW="$2"; return 0; else return 1; fi; }
_env_get() { case "$1" in NEO4J_PASSWORD) echo "$RECON_ENVPW";; NEO4J_PASSWORD_OLD) echo "$RECON_OLDPW";; *) echo "";; esac; }
_reset_recon() { LOCKED=""; NEO4J_RUNNING=1; COMPOSE_UP_RC=0; WAIT_RC=0; ROTATE_CALLS=0; DOCKER_CALLS=0; RESTART_RC=0; RECON_OLDPW=""; }

# (a) .env password already matches the volume -> OK, no rotation performed.
_reset_recon; RECON_ENVPW="envsecret"; GOODPW="envsecret"
_reconcile_neo4j_password "$RECON_ENVPW" >/dev/null 2>&1
assert_eq "reconcile: matching .env password -> 0"          "$?" "0"
assert_eq "reconcile: matching password does NOT rotate"    "$ROTATE_CALLS" "0"

# (b) volume still on changeme123, .env holds the new value -> rotate to match.
_reset_recon; RECON_ENVPW="envsecret"; GOODPW="changeme123"
_reconcile_neo4j_password "$RECON_ENVPW" >/dev/null 2>&1
rc=$?
assert_eq "reconcile: legacy changeme123 volume -> rotated -> 0" "$rc" "0"
assert_eq "reconcile: volume now accepts the .env password"      "$GOODPW" "envsecret"

# (c) volume on an unknown password, no NEO4J_PASSWORD_OLD hint -> cannot fix -> 1.
_reset_recon; RECON_ENVPW="envsecret"; GOODPW="totally-unknown"
_reconcile_neo4j_password "$RECON_ENVPW" >/dev/null 2>&1
assert_eq "reconcile: un-reconcilable mismatch -> 1" "$?" "1"

# (d) unknown live password but operator supplied NEO4J_PASSWORD_OLD -> rotate.
_reset_recon; RECON_ENVPW="envsecret"; RECON_OLDPW="prev-known-pw"; GOODPW="prev-known-pw"
_reconcile_neo4j_password "$RECON_ENVPW" >/dev/null 2>&1
rc=$?
assert_eq "reconcile: NEO4J_PASSWORD_OLD hint -> rotated -> 0" "$rc" "0"
assert_eq "reconcile: volume rotated to .env via OLD hint"     "$GOODPW" "envsecret"

# (e) empty envpw -> immediate 0, touches nothing (guard clause).
_reset_recon; RECON_ENVPW=""; GOODPW="whatever"
_reconcile_neo4j_password "" >/dev/null 2>&1
assert_eq "reconcile: empty password -> 0 (guard)"    "$?" "0"
assert_eq "reconcile: empty password touches no docker" "$DOCKER_CALLS" "0"

# (f) THE #160 CASE: password is correct but auth is rate-limited. A restart
#     clears the lockout and auth then succeeds -> 0, WITHOUT any rotation.
_reset_recon; RECON_ENVPW="envsecret"; GOODPW="envsecret"; LOCKED="yes"
_reconcile_neo4j_password "$RECON_ENVPW" >/dev/null 2>&1
rc=$?
assert_eq "reconcile: rate-limited-but-correct -> restart clears -> 0" "$rc" "0"
assert_eq "reconcile: rate-limit clear does NOT rotate"                "$ROTATE_CALLS" "0"

# (g) Neo4j down AND compose cannot start it -> fail-safe 0 (never block a start).
_reset_recon; RECON_ENVPW="envsecret"; GOODPW="envsecret"; NEO4J_RUNNING=""; COMPOSE_UP_RC=1
_reconcile_neo4j_password "$RECON_ENVPW" >/dev/null 2>&1
assert_eq "reconcile: cannot start neo4j -> fail-safe 0" "$?" "0"

# (h) Neo4j never becomes healthy (_kb_wait_neo4j fails) -> fail-safe 0.
_reset_recon; RECON_ENVPW="envsecret"; GOODPW="envsecret"; WAIT_RC=1
_reconcile_neo4j_password "$RECON_ENVPW" >/dev/null 2>&1
assert_eq "reconcile: neo4j never healthy -> fail-safe 0" "$?" "0"

# (i) genuinely locked out with a WRONG .env password -> restart clears lock but
#     auth still fails and no candidate matches -> un-reconcilable 1.
_reset_recon; RECON_ENVPW="wrongpw"; GOODPW="the-real-one"; LOCKED="yes"
_reconcile_neo4j_password "$RECON_ENVPW" >/dev/null 2>&1
assert_eq "reconcile: locked + wrong pw + no candidate -> 1" "$?" "1"

# (j) set -e regression: reconcile runs from an `if !` condition, so bash disables
#     set -e for the whole function -- a standalone `docker restart` that returns
#     non-zero must NOT abort the caller. Prove it under a real `set -e` subshell:
#     the un-reconcilable path returns 1 and execution reaches the line AFTER.
_reset_recon; RECON_ENVPW="envsecret"; GOODPW="nope"; RESTART_RC=1
sete_out="$( set -e; if ! _reconcile_neo4j_password "$RECON_ENVPW" >/dev/null 2>&1; then echo GOT1; fi; echo AFTER )"
assert_true "reconcile under set -e: failing restart does not abort caller" "[[ \"\$sete_out\" == *GOT1*AFTER* ]]"
unset -f docker _kb_wait_neo4j _rotate_neo4j_password _env_get _reset_recon

# test_kb_make_injects_real_password (issue #160, integration): _kb_make must run
# `make -C knowledge_base` with NEO4J_PASSWORD taken from .env, NOT empty and NOT
# changeme123. We stub `make` to echo the value it received in its environment.
echo "== _kb_make injects the real .env password into make =="
make() { printf 'MADE NEO4J_PASSWORD=[%s] ARGS=[%s]\n' "${NEO4J_PASSWORD:-}" "$*"; }
_env_get() { [[ "$1" == "NEO4J_PASSWORD" ]] && echo "env-real-pw-123"; }
kb_out="$(_kb_make kb-stats 2>&1)"
unset -f make _env_get
assert_true "_kb_make passes the .env password to make"     "echo \"\$kb_out\" | grep -q 'NEO4J_PASSWORD=\[env-real-pw-123\]'"
assert_false "_kb_make does NOT leak changeme123"           "echo \"\$kb_out\" | grep -q 'changeme123'"
assert_true "_kb_make forwards the make target"             "echo \"\$kb_out\" | grep -q 'ARGS=\[.*kb-stats.*\]'"

# test_kb_makefile_dryrun (issue #160, integration): a real `make -n` on the KB
# Makefile must (1) embed the supplied password QUOTED into the recipe, and (2)
# with the var unset, emit an EMPTY quoted arg (never changeme123). `make -n`
# prints the recipe without executing it. Skipped gracefully if make is absent.
if command -v make >/dev/null 2>&1; then
    echo "== KB Makefile expands --neo4j-password from env, no default (make -n) =="
    KBDIR="$REPO_ROOT/services/knowledge_base"
    dry_set="$(NEO4J_PASSWORD='sup3r-secret' MODE=docker make -C "$KBDIR" -n kb-stats 2>/dev/null)"
    dry_unset="$(env -u NEO4J_PASSWORD MODE=docker make -C "$KBDIR" -n kb-stats 2>/dev/null)"
    assert_true  "make -n: password passed quoted when env set" "printf '%s' \"\$dry_set\" | grep -q -- '--neo4j-password \"sup3r-secret\"'"
    assert_false "make -n: no changeme123 when env unset"       "printf '%s' \"\$dry_unset\" | grep -q 'changeme123'"
    assert_true  "make -n: empty quoted arg when env unset"     "printf '%s' \"\$dry_unset\" | grep -q -- '--neo4j-password \"\"'"
else
    echo "== KB Makefile make -n test SKIPPED (make not installed) =="
fi

# =============================================================================
# GVM/OpenVAS is not a REAmon runtime feature. Legacy markers must not reactivate
# credential writes or scanner administration during install/reconciliation.
# =============================================================================

echo "== ensure_gvm_secret: GVM disabled -> no-op =="
TMP=$(mktemp -d); SCRIPT_DIR="$TMP"; : > "$TMP/.env"
GVM_FLAG_FILE="$TMP/.gvm-enabled"   # absent -> is_gvm_enabled false
ensure_gvm_secret >/dev/null 2>&1
assert_false "no GVM_PASSWORD written when GVM disabled" "grep -q '^GVM_PASSWORD=' '$TMP/.env'"
rm -rf "$TMP"

echo "== ensure_gvm_secret: stale legacy marker remains disabled =="
TMP=$(mktemp -d); SCRIPT_DIR="$TMP"; : > "$TMP/.env"
GVM_FLAG_FILE="$TMP/.gvm-enabled"; touch "$GVM_FLAG_FILE"
ensure_gvm_secret >/dev/null 2>&1
assert_false "legacy marker does not write GVM_PASSWORD" "grep -q '^GVM_PASSWORD=' '$TMP/.env'"
rm -rf "$TMP"

echo "== reconcile_gvm_admin_password: stale legacy marker is inert =="
# Capture counters in this shell to prove that legacy config cannot reach Docker.
CAP="$(mktemp)"
sleep() { :; }
GVMD_HEALTH="healthy"; GVM_ROTATE_CALLS=0; GVM_ROTATE_RC=0; DOCKER_CALLS=0; RECON_GVM_PW="envpw"
docker() { DOCKER_CALLS=$((DOCKER_CALLS+1)); case "${1:-}" in inspect) echo "$GVMD_HEALTH";; *) return 0;; esac; }
_rotate_gvm_admin_password() { GVM_ROTATE_CALLS=$((GVM_ROTATE_CALLS+1)); return "$GVM_ROTATE_RC"; }
_env_get() { [[ "$1" == "GVM_PASSWORD" ]] && echo "$RECON_GVM_PW"; return 0; }
_reset_gvm() { GVMD_HEALTH="healthy"; GVM_ROTATE_CALLS=0; GVM_ROTATE_RC=0; DOCKER_CALLS=0; RECON_GVM_PW="envpw"; }

_reset_gvm; TMP=$(mktemp -d); SCRIPT_DIR="$TMP"; GVM_FLAG_FILE="$TMP/.gvm-enabled"; touch "$GVM_FLAG_FILE"
printf 'GVM_PASSWORD=legacy-password\n' > "$TMP/.env"
ensure_gvm_secret >/dev/null 2>&1
reconcile_gvm_admin_password >"$CAP" 2>&1; rc=$?
assert_eq "reconcile: stale marker -> 0" "$rc" "0"
assert_eq "reconcile: stale marker touches no docker" "$DOCKER_CALLS" "0"
assert_eq "reconcile: stale marker does not rotate" "$GVM_ROTATE_CALLS" "0"
assert_eq "reconcile: legacy password stays unchanged" "$(cat "$TMP/.env")" "GVM_PASSWORD=legacy-password"
rm -rf "$TMP"
unset -f sleep docker _rotate_gvm_admin_password _env_get _reset_gvm; rm -f "$CAP"

echo "== redamon.sh: GVM provisioning wired into install/update =="
SRC="$REPO_ROOT/redamon.sh"
assert_true "ensure_gvm_secret defined"            "grep -q '^ensure_gvm_secret()' '$SRC'"
assert_true "reconcile_gvm_admin_password defined" "grep -q '^reconcile_gvm_admin_password()' '$SRC'"
assert_true "_rotate_gvm_admin_password defined"   "grep -q '^_rotate_gvm_admin_password()' '$SRC'"
# cmd_install: GVM_PASSWORD must be pinned BEFORE the stack comes up.
i_start=$(grep -n '^cmd_install()' "$SRC" | head -1 | cut -d: -f1)
i_end=$(awk -v s="$i_start" 'NR>s && /^cmd_[a-z_]*\(\)/{print NR; exit}' "$SRC")
gen_line=$(awk -v s="$i_start" -v e="$i_end" 'NR>s && NR<e && /ensure_gvm_secret/{print NR; exit}' "$SRC")
up_line=$(awk -v s="$i_start" -v e="$i_end" 'NR>s && NR<e && /docker compose up -d --force-recreate/{print NR; exit}' "$SRC")
# anchor at line start so a comment mentioning the function is not mistaken for the call
apply_line=$(awk -v s="$i_start" -v e="$i_end" 'NR>s && NR<e && /^[[:space:]]*reconcile_gvm_admin_password/{print NR; exit}' "$SRC")
assert_true "cmd_install pins GVM_PASSWORD ($gen_line) before up ($up_line)" "[[ -n '$gen_line' && -n '$up_line' && '$gen_line' -lt '$up_line' ]]"
assert_true "cmd_install applies it after up ($apply_line > $up_line)"       "[[ -n '$apply_line' && '$apply_line' -gt '$up_line' ]]"
# cmd_update: both present.
u_start=$(grep -n '^cmd_update()' "$SRC" | head -1 | cut -d: -f1)
u_end=$(awk -v s="$u_start" 'NR>s && /^cmd_[a-z_]*\(\)/{print NR; exit}' "$SRC")
assert_true "cmd_update pins GVM_PASSWORD"   "awk -v s=$u_start -v e=$u_end 'NR>s&&NR<e&&/ensure_gvm_secret/{f=1} END{exit !f}' '$SRC'"
assert_true "cmd_update reconciles gvmd"     "awk -v s=$u_start -v e=$u_end 'NR>s&&NR<e&&/reconcile_gvm_admin_password/{f=1} END{exit !f}' '$SRC'"

echo "== deploy.sh: gvm_note no longer mints a throwaway password =="
DEP="$REPO_ROOT/tooling/deploy/single-host/deploy.sh"
gn_start=$(grep -n '^gvm_note()' "$DEP" | head -1 | cut -d: -f1)
gn_end=$(awk -v s="$gn_start" 'NR>s && /^}/{print NR; exit}' "$DEP")
assert_false "gvm_note does not openssl-rand a new password" "awk -v s=$gn_start -v e=$gn_end 'NR>s&&NR<e&&/openssl rand/{f=1} END{exit !f}' '$DEP'"
assert_true  "gvm_note reads GVM_PASSWORD from .env"         "awk -v s=$gn_start -v e=$gn_end 'NR>s&&NR<e&&/GVM_PASSWORD=.*\\.env/{f=1} END{exit !f}' '$DEP'"

echo
echo "-----------------------------------------"
printf 'Secrets suite: \033[0;32m%d passed\033[0m, ' "$PASS"
if [[ $FAIL -gt 0 ]]; then printf '\033[0;31m%d failed\033[0m\n' "$FAIL"; exit 1; else printf '%d failed\n' "$FAIL"; fi

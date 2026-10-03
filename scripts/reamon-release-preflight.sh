#!/usr/bin/env bash
# Validate the REAmon Compose release before traffic is sent to it.
#
# Default mode is safe before deployment: it renders Compose and checks that the
# production Dockerfile packages the bounded process-provider tools. `--live`
# adds checks against an already-running webapp without exposing configuration
# or secret values.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIVE=0

usage() {
  cat <<'USAGE'
Usage: scripts/reamon-release-preflight.sh [--live]

Options:
  --live  Also check the running webapp readiness endpoint, writable artifact
          storage, bundled process-provider tools, and configured source roots.
USAGE
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$*"
}

while (($#)); do
  case "$1" in
    --live) LIVE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
  shift
done

cd "$REPO_ROOT"
command -v docker >/dev/null 2>&1 || fail 'docker is not installed or not on PATH'
docker compose version >/dev/null 2>&1 || fail 'docker compose is not available'

docker compose config --quiet || fail 'Compose configuration is invalid or required deployment variables are missing'
pass 'Compose configuration renders'

grep -Eq 'binutils[[:space:]]+file|file[[:space:]]+binutils' webapp/Dockerfile \
  || fail 'webapp/Dockerfile does not package both binutils and file'
pass 'production image declares strings/readelf and file runtime dependencies'

if [[ -n "${REAMON_SERVER_SOURCE_ROOTS:-}" ]]; then
  while IFS= read -r source_root; do
    [[ -z "$source_root" ]] && continue
    [[ "$source_root" == /* ]] || fail 'REAMON_SERVER_SOURCE_ROOTS contains a non-absolute path'
  done <<< "$REAMON_SERVER_SOURCE_ROOTS"
  pass 'configured server source roots use absolute paths'
else
  pass 'server-mounted imports are disabled'
fi

if ((LIVE)); then
  command -v curl >/dev/null 2>&1 || fail 'curl is required for --live checks'
  docker compose ps --status running --services | grep -Fxq webapp \
    || fail 'webapp is not running'

  webapp_port="${WEBAPP_PORT:-3000}"
  curl --fail --silent --show-error --max-time "${REAMON_PREFLIGHT_TIMEOUT_SECONDS:-10}" \
    "http://127.0.0.1:${webapp_port}/api/health/ready" >/dev/null \
    || fail 'webapp readiness endpoint is not healthy'
  pass 'webapp readiness endpoint is healthy'

  docker compose exec -T webapp sh -lc \
    'test -d "${REAMON_ARTIFACTS_PATH:-/data/reamon-artifacts}" && test -w "${REAMON_ARTIFACTS_PATH:-/data/reamon-artifacts}"' \
    || fail 'artifact storage is not writable inside webapp'
  pass 'artifact storage is writable inside webapp'

  docker compose exec -T webapp sh -lc \
    'command -v strings >/dev/null && command -v readelf >/dev/null && command -v file >/dev/null' \
    || fail 'required REAmon process-provider tools are missing from the running image'
  pass 'running image contains strings, readelf, and file'

  while IFS= read -r source_root; do
    [[ -z "$source_root" ]] && continue
    docker compose exec -T webapp sh -c 'test -d "$1" && test ! -L "$1"' sh "$source_root" \
      || fail "configured server source root is not a directory in the webapp container"
  done <<< "${REAMON_SERVER_SOURCE_ROOTS:-}"
  if [[ -n "${REAMON_SERVER_SOURCE_ROOTS:-}" ]]; then
    pass 'configured server source roots are present as non-symlink directories'
  fi
fi

pass 'REAmon release preflight complete'

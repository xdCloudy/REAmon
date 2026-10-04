#!/usr/bin/env bash
# Verify a PostgreSQL custom dump and artifact archive by restoring only into
# explicitly supplied staging targets. The script refuses to guess a target.
set -euo pipefail

MODE="${1:---check}"
case "$MODE" in
  --check)
    command -v tar >/dev/null 2>&1 || { echo 'FAIL: tar is required' >&2; exit 1; }
    bash -n "$0"
    echo 'PASS: backup/restore drill wrapper is available (run --run or --compose in a staging environment)'
    exit 0
    ;;
  --run)
    : "${REAMON_DRILL_SOURCE_DATABASE_URL:?REAMON_DRILL_SOURCE_DATABASE_URL is required}"
    : "${REAMON_DRILL_RESTORE_DATABASE_URL:?REAMON_DRILL_RESTORE_DATABASE_URL is required}"
    : "${REAMON_DRILL_ARTIFACT_ROOT:?REAMON_DRILL_ARTIFACT_ROOT is required}"
    [[ "$REAMON_DRILL_SOURCE_DATABASE_URL" != "$REAMON_DRILL_RESTORE_DATABASE_URL" ]] || { echo 'FAIL: source and restore database URLs must differ' >&2; exit 2; }
    [[ -d "$REAMON_DRILL_ARTIFACT_ROOT" ]] || { echo 'FAIL: artifact root is not a directory' >&2; exit 2; }
    ;;
  --compose)
    : "${REAMON_DRILL_COMPOSE_RESTORE_DATABASE:?REAMON_DRILL_COMPOSE_RESTORE_DATABASE is required}"
    : "${REAMON_DRILL_COMPOSE_ARTIFACT_ROOT:=/data/reamon-artifacts}"
    command -v docker >/dev/null 2>&1 || { echo 'FAIL: docker is required for --compose' >&2; exit 2; }
    docker compose version >/dev/null 2>&1 || { echo 'FAIL: docker compose is required for --compose' >&2; exit 2; }
    [[ "$REAMON_DRILL_COMPOSE_RESTORE_DATABASE" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
      echo 'FAIL: restore database name must contain only PostgreSQL identifier characters' >&2
      exit 2
    }
    source_database="${POSTGRES_DB:-redamon}"
    source_user="${POSTGRES_USER:-redamon}"
    [[ "$source_database" != "$REAMON_DRILL_COMPOSE_RESTORE_DATABASE" ]] || {
      echo 'FAIL: source and restore database names must differ' >&2
      exit 2
    }
    ;;
  *) echo 'Usage: scripts/reamon-backup-restore-drill.sh [--check|--run|--compose]' >&2; exit 2 ;;
esac

workdir="${REAMON_DRILL_OUTPUT_DIR:-$(mktemp -d)}"
mkdir -p "$workdir"
dump="$workdir/reamon-postgres.dump"
archive="$workdir/reamon-artifacts.tar.gz"
restore_artifacts="$workdir/restored-artifacts"
mkdir -p "$restore_artifacts"

if [[ "$MODE" == '--compose' ]]; then
  docker compose exec -T -e PGUSER="$source_user" postgres dropdb --if-exists --maintenance-db=postgres "$REAMON_DRILL_COMPOSE_RESTORE_DATABASE" >/dev/null
  docker compose exec -T -e PGUSER="$source_user" postgres createdb --maintenance-db=postgres --owner="$source_user" "$REAMON_DRILL_COMPOSE_RESTORE_DATABASE"
  docker compose exec -T -e PGUSER="$source_user" postgres pg_dump --format=custom --dbname="$source_database" >"$dump"
  docker compose exec -T -e PGUSER="$source_user" postgres pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$REAMON_DRILL_COMPOSE_RESTORE_DATABASE" <"$dump"
  docker compose exec -T -e PGUSER="$source_user" postgres psql --quiet --no-psqlrc --set=ON_ERROR_STOP=1 --dbname="$REAMON_DRILL_COMPOSE_RESTORE_DATABASE" --command='SELECT 1' >/dev/null
  docker compose exec -T webapp tar --create --gzip --file=- --directory="$REAMON_DRILL_COMPOSE_ARTIFACT_ROOT" . >"$archive"
else
  pg_dump --format=custom --file="$dump" "$REAMON_DRILL_SOURCE_DATABASE_URL"
  pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$REAMON_DRILL_RESTORE_DATABASE_URL" "$dump"
  psql --quiet --no-psqlrc --set=ON_ERROR_STOP=1 --dbname="$REAMON_DRILL_RESTORE_DATABASE_URL" --command='SELECT 1' >/dev/null
  tar --create --gzip --file="$archive" --directory="$REAMON_DRILL_ARTIFACT_ROOT" .
fi

tar --list --file="$archive" >/dev/null
tar --extract --file="$archive" --directory="$restore_artifacts"
find "$restore_artifacts" -type f -print -quit | grep -q . || { echo 'FAIL: restored artifact archive contains no files' >&2; exit 1; }
if [[ "$MODE" == '--compose' ]]; then
  docker compose exec -T -e PGUSER="$source_user" postgres dropdb --if-exists --maintenance-db=postgres "$REAMON_DRILL_COMPOSE_RESTORE_DATABASE" >/dev/null
fi
echo "PASS: database restored and artifact archive extracted in $workdir"

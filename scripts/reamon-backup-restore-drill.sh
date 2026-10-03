#!/usr/bin/env bash
# Verify a PostgreSQL custom dump and artifact archive by restoring only into
# explicitly supplied staging targets. The script refuses to guess a target.
set -euo pipefail

MODE="${1:---check}"
case "$MODE" in
  --check)
    command -v tar >/dev/null 2>&1 || { echo 'FAIL: tar is required' >&2; exit 1; }
    bash -n "$0"
    echo 'PASS: backup/restore drill wrapper is available (run --run in a PostgreSQL tooling environment)'
    exit 0
    ;;
  --run)
    : "${REAMON_DRILL_SOURCE_DATABASE_URL:?REAMON_DRILL_SOURCE_DATABASE_URL is required}"
    : "${REAMON_DRILL_RESTORE_DATABASE_URL:?REAMON_DRILL_RESTORE_DATABASE_URL is required}"
    : "${REAMON_DRILL_ARTIFACT_ROOT:?REAMON_DRILL_ARTIFACT_ROOT is required}"
    [[ "$REAMON_DRILL_SOURCE_DATABASE_URL" != "$REAMON_DRILL_RESTORE_DATABASE_URL" ]] || { echo 'FAIL: source and restore database URLs must differ' >&2; exit 2; }
    [[ -d "$REAMON_DRILL_ARTIFACT_ROOT" ]] || { echo 'FAIL: artifact root is not a directory' >&2; exit 2; }
    ;;
  *) echo 'Usage: scripts/reamon-backup-restore-drill.sh [--check|--run]' >&2; exit 2 ;;
esac

workdir="${REAMON_DRILL_OUTPUT_DIR:-$(mktemp -d)}"
mkdir -p "$workdir"
dump="$workdir/reamon-postgres.dump"
archive="$workdir/reamon-artifacts.tar.gz"
pg_dump --format=custom --file="$dump" "$REAMON_DRILL_SOURCE_DATABASE_URL"
pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$REAMON_DRILL_RESTORE_DATABASE_URL" "$dump"
psql --quiet --no-psqlrc --set=ON_ERROR_STOP=1 --dbname="$REAMON_DRILL_RESTORE_DATABASE_URL" --command='SELECT 1' >/dev/null
tar --create --gzip --file="$archive" --directory="$REAMON_DRILL_ARTIFACT_ROOT" .
tar --list --file="$archive" >/dev/null
echo "PASS: database restored and artifact archive verified in $workdir"

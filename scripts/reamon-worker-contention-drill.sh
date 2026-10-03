#!/usr/bin/env bash
# Run two authenticated dispatchers against one disposable staging workspace.
# The database lease is the assertion: a task id may be returned by at most one
# concurrent dispatcher. No production identifier or credential is persisted.
set -euo pipefail

WEBAPP_URL="${REAMON_DRILL_WEBAPP_URL:-http://127.0.0.1:3000}"
INTERNAL_KEY="${REAMON_DRILL_INTERNAL_KEY:-}"
PROJECT_ID="${REAMON_DRILL_PROJECT_ID:-}"
[[ -n "$INTERNAL_KEY" ]] || { echo 'REAMON_DRILL_INTERNAL_KEY is required' >&2; exit 2; }
[[ -n "$PROJECT_ID" ]] || { echo 'REAMON_DRILL_PROJECT_ID is required' >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo 'curl is required' >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo 'node is required' >&2; exit 2; }

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

dispatch() {
  local worker="$1" output="$2"
  curl --fail-with-body --silent --show-error --max-time "${REAMON_DRILL_TIMEOUT_SECONDS:-30}" \
    -H 'content-type: application/json' -H "x-internal-key: $INTERNAL_KEY" \
    -d "{\"projectId\":\"$PROJECT_ID\",\"limit\":1,\"recoverStale\":false,\"workerId\":\"$worker\"}" \
    "$WEBAPP_URL/api/internal/reamon/tasks/dispatch" >"$output"
}

dispatch reamon-drill-a "$scratch/a.json" & pid_a=$!
dispatch reamon-drill-b "$scratch/b.json" & pid_b=$!
wait "$pid_a"
wait "$pid_b"

node - "$scratch/a.json" "$scratch/b.json" <<'NODE'
const fs = require('node:fs')
const paths = process.argv.slice(2)
const payloads = paths.map((path) => JSON.parse(fs.readFileSync(path, 'utf8')))
const workers = payloads.map((payload) => payload.workerId)
if (new Set(workers).size !== 2) throw new Error(`worker identity collision: ${workers.join(',')}`)
const taskIds = payloads.flatMap((payload) => (payload.results || []).map((entry) => entry.task?.id).filter(Boolean))
if (new Set(taskIds).size !== taskIds.length) throw new Error(`duplicate task claim observed: ${taskIds.join(',')}`)
console.log(`PASS: concurrent workers=${workers.join(',')} taskClaims=${taskIds.length}`)
NODE

#!/usr/bin/env bash
# Run a bounded worker load/soak check after the crash-recovery drill.
set -euo pipefail

ARTIFACT_ID="${REAMON_SOAK_ARTIFACT_ID:-}"
COUNT="${REAMON_SOAK_TASK_COUNT:-4}"
MAX_WAIT_SECONDS="${REAMON_SOAK_MAX_WAIT_SECONDS:-120}"
SOAK_SECONDS="${REAMON_SOAK_DURATION_SECONDS:-30}"

[[ -n "$ARTIFACT_ID" ]] || { echo 'REAMON_SOAK_ARTIFACT_ID is required' >&2; exit 2; }
[[ "$COUNT" =~ ^[0-9]+$ ]] && (( COUNT >= 1 && COUNT <= 20 )) || { echo 'REAMON_SOAK_TASK_COUNT must be 1..20' >&2; exit 2; }
[[ "$MAX_WAIT_SECONDS" =~ ^[0-9]+$ && "$SOAK_SECONDS" =~ ^[0-9]+$ ]] || { echo 'soak timing values must be integers' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'docker is required' >&2; exit 2; }

compose() { docker compose "$@"; }
restore_worker_scale() { compose up -d --no-build --scale reamon-worker=1 reamon-worker >/dev/null 2>&1 || true; }
trap restore_worker_scale EXIT

compose up -d --no-build --scale reamon-worker=2 reamon-worker >/dev/null
mapfile -t workers < <(compose ps -q reamon-worker)
((${#workers[@]} == 2)) || { echo "FAIL: soak requires two worker replicas, found ${#workers[@]}" >&2; exit 1; }
restart_before="$(docker inspect --format '{{.RestartCount}}' "${workers[0]}")"

soak_json="$(compose exec -T webapp node scripts/reamon-create-soak-tasks.mjs "$ARTIFACT_ID" "$COUNT")"
echo "PASS: created bounded worker soak: ${soak_json}"
mapfile -t task_ids < <(node -e 'const value=JSON.parse(process.argv[1]); for (const id of value.taskIds) console.log(id)' "$soak_json")

complete=0
for attempt in $(seq 1 "$MAX_WAIT_SECONDS"); do
  status_json="$(compose exec -T webapp node scripts/reamon-soak-status.mjs "${task_ids[@]}" 2>/dev/null || true)"
  complete="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(String(value.completed))' "$status_json" 2>/dev/null || echo 0)"
  failed="$(node -e 'const value=JSON.parse(process.argv[1]); process.stdout.write(String(value.failed))' "$status_json" 2>/dev/null || echo 0)"
  if (( failed > 0 )); then
    echo "FAIL: worker soak produced failed tasks" >&2
    exit 1
  fi
  if (( complete == COUNT )); then
    break
  fi
  sleep 1
done

if (( complete != COUNT )); then
  echo "FAIL: worker soak completed ${complete}/${COUNT} tasks" >&2
  compose logs --tail=160 reamon-worker >&2 || true
  exit 1
fi

sleep "$SOAK_SECONDS"
mapfile -t workers_after < <(compose ps -q reamon-worker)
restart_after="$(docker inspect --format '{{.RestartCount}}' "${workers_after[0]}")"
if ((${#workers_after[@]} != 2)) || [[ "$restart_before" != "$restart_after" ]]; then
  echo "FAIL: worker replicas were not stable during ${SOAK_SECONDS}s soak" >&2
  compose ps reamon-worker >&2 || true
  exit 1
fi
echo "PASS: worker load/soak completed ${COUNT} tasks with two stable replicas for ${SOAK_SECONDS}s"

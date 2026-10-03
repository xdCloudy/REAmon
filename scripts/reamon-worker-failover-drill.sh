#!/usr/bin/env bash
# Exercise the real Compose worker deployment, including a replica crash.
# A controlled approved task is given a stale lease owned by one worker,
# that container is killed, and the surviving replica must recover and finish
# it exactly once.
set -euo pipefail

TASK_ID="${REAMON_FAILOVER_TASK_ID:-}"
STALE_AFTER_MINUTES="${REAMON_FAILOVER_STALE_AFTER_MINUTES:-5}"
MAX_WAIT_SECONDS="${REAMON_FAILOVER_MAX_WAIT_SECONDS:-90}"

[[ -n "$TASK_ID" ]] || { echo 'REAMON_FAILOVER_TASK_ID is required' >&2; exit 2; }
[[ "$STALE_AFTER_MINUTES" =~ ^[0-9]+$ ]] && (( STALE_AFTER_MINUTES >= 5 && STALE_AFTER_MINUTES <= 1440 )) || {
  echo 'REAMON_FAILOVER_STALE_AFTER_MINUTES must be an integer from 5 to 1440' >&2
  exit 2
}
[[ "$MAX_WAIT_SECONDS" =~ ^[0-9]+$ ]] || { echo 'REAMON_FAILOVER_MAX_WAIT_SECONDS must be an integer' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'docker is required' >&2; exit 2; }

compose() { docker compose "$@"; }
restore_worker_scale() { compose up -d --no-build --scale reamon-worker=1 reamon-worker >/dev/null 2>&1 || true; }
trap restore_worker_scale EXIT

compose rm -sf reamon-worker >/dev/null 2>&1 || true
# Create the containers without starting them. This closes the race where a
# freshly approved task could be consumed before the drill seeds its stale
# lease, while still giving the lease the exact hostname of the replica that
# will be killed.
compose create --no-build --scale reamon-worker=2 reamon-worker >/dev/null

containers=()
for attempt in $(seq 1 30); do
  mapfile -t containers < <(compose ps -aq reamon-worker)
  if ((${#containers[@]} >= 2)); then break; fi
  sleep 2
done
if ((${#containers[@]} != 2)); then
  compose ps reamon-worker >&2 || true
  echo "FAIL: expected two running worker replicas, found ${#containers[@]}" >&2
  exit 1
fi

dead_container="${containers[0]}"
survivor_container="${containers[1]}"
dead_worker="$(docker inspect --format '{{.Config.Hostname}}' "$dead_container")"
survivor_worker="$(docker inspect --format '{{.Config.Hostname}}' "$survivor_container")"
[[ -n "$dead_worker" && -n "$survivor_worker" && "$dead_worker" != "$survivor_worker" ]] || {
  echo 'FAIL: worker replicas did not expose distinct identities' >&2
  exit 1
}

seeded="$(compose exec -T webapp node scripts/reamon-seed-stale-task.mjs "$TASK_ID" "$dead_worker" "$STALE_AFTER_MINUTES")"
echo "PASS: replicas=${dead_worker},${survivor_worker} seeded stale lease: $seeded"

docker start "${containers[0]}" "${containers[1]}" >/dev/null
for attempt in $(seq 1 30); do
  mapfile -t running_containers < <(compose ps -q reamon-worker)
  if ((${#running_containers[@]} >= 2)); then break; fi
  sleep 2
done
if ((${#running_containers[@]} != 2)); then
  compose ps reamon-worker >&2 || true
  echo 'FAIL: both worker replicas did not start after the stale lease was seeded' >&2
  exit 1
fi

docker kill --signal KILL "$dead_container" >/dev/null
echo "PASS: killed worker replica=${dead_worker}; waiting for surviving replica=${survivor_worker} to recover the lease"

for attempt in $(seq 1 "$MAX_WAIT_SECONDS"); do
  status_json="$(compose exec -T webapp node scripts/reamon-task-status.mjs "$TASK_ID" 2>/dev/null || true)"
  if [[ -n "$status_json" ]]; then
    status="$(node -e 'const value = JSON.parse(process.argv[1]); process.stdout.write(value.status)' "$status_json" 2>/dev/null || true)"
    recovery_events="$(node -e 'const value = JSON.parse(process.argv[1]); process.stdout.write(String(value.recoveryEvents))' "$status_json" 2>/dev/null || true)"
    completion_events="$(node -e 'const value = JSON.parse(process.argv[1]); process.stdout.write(String(value.completionEvents))' "$status_json" 2>/dev/null || true)"
    if [[ "$status" == COMPLETED && "$recovery_events" == 1 && "$completion_events" == 1 ]]; then
      echo "PASS: stale threshold=${STALE_AFTER_MINUTES}m crossed; surviving worker recovered and completed task exactly once"
      echo "$status_json"
      exit 0
    fi
  fi
  sleep 1
done

echo "FAIL: worker failover did not produce one recovered completion within ${MAX_WAIT_SECONDS}s" >&2
compose ps reamon-worker >&2 || true
compose logs --tail=160 reamon-worker >&2 || true
exit 1

#!/usr/bin/env bash
# Verify a Neo4j database dump can be loaded into an isolated database and
# queried before the staging deployment is started again.
set -euo pipefail

MODE="${1:---check}"
case "$MODE" in
  --check)
    command -v docker >/dev/null 2>&1 || { echo 'FAIL: docker is required for the Neo4j drill' >&2; exit 1; }
    docker compose version >/dev/null 2>&1 || { echo 'FAIL: docker compose is required for the Neo4j drill' >&2; exit 1; }
    bash -n "$0"
    echo 'PASS: Neo4j backup/restore drill wrapper is available'
    exit 0
    ;;
  --compose)
    : "${NEO4J_PASSWORD:?NEO4J_PASSWORD is required}"
    : "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is required for --compose}"
    command -v docker >/dev/null 2>&1 || { echo 'FAIL: docker is required for --compose' >&2; exit 2; }
    docker compose version >/dev/null 2>&1 || { echo 'FAIL: docker compose is required for --compose' >&2; exit 2; }
    ;;
  *) echo 'Usage: scripts/reamon-neo4j-backup-restore-drill.sh [--check|--compose]' >&2; exit 2 ;;
esac

workdir="${REAMON_NEO4J_DRILL_OUTPUT_DIR:-$(mktemp -d)}"
mkdir -p "$workdir"
dump_dir="$workdir/neo4j-dump"
restore_volume="${REAMON_NEO4J_RESTORE_VOLUME:-${COMPOSE_PROJECT_NAME}_neo4j_restore_check}"
restore_container="${COMPOSE_PROJECT_NAME}-neo4j-restore-check"
neo4j_image="${REAMON_NEO4J_IMAGE:-neo4j:5.26-community}"
neo4j_container=""
mkdir -p "$dump_dir"
# The Neo4j admin image may run with a remapped UID even when --user 0 is
# requested. This is an isolated, operator-selected evidence directory.
chmod 777 "$dump_dir"

[[ "$restore_volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || {
  echo 'FAIL: restore volume name is invalid' >&2
  exit 2
}

cleanup() {
  docker rm -f "$restore_container" >/dev/null 2>&1 || true
  docker volume rm "$restore_volume" >/dev/null 2>&1 || true
  if [[ -n "$neo4j_container" ]]; then
    docker compose start neo4j >/dev/null 2>&1 || true
    docker compose start webapp >/dev/null 2>&1 || true
    docker compose start reamon-worker >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

neo4j_container="$(docker compose ps -q neo4j)"
[[ -n "$neo4j_container" ]] || { echo 'FAIL: Compose Neo4j service is not present' >&2; exit 1; }

# neo4j-admin refuses to dump a database mounted by a running server. Stop graph
# writers and Neo4j for the minimum time needed to produce the archive.
docker compose stop reamon-worker webapp neo4j >/dev/null
docker run --rm --user 0 --volumes-from "$neo4j_container" -v "$dump_dir:/backup" "$neo4j_image" \
  neo4j-admin database dump neo4j --to-path=/backup --overwrite-destination=true >/dev/null
[[ -s "$dump_dir/neo4j.dump" ]] || { echo 'FAIL: Neo4j dump is empty or missing' >&2; exit 1; }

docker volume create "$restore_volume" >/dev/null
docker run --rm --user 0 -v "$restore_volume:/data" -v "$dump_dir:/backup:ro" "$neo4j_image" \
  neo4j-admin database load neo4j --from-path=/backup --overwrite-destination=true >/dev/null
docker run --rm --user 0 -v "$restore_volume:/data" "$neo4j_image" chown -R neo4j:neo4j /data

docker run -d --name "$restore_container" \
  -v "$restore_volume:/data" \
  -e "NEO4J_AUTH=neo4j/$NEO4J_PASSWORD" \
  -e NEO4J_server_memory_heap_initial__size=256m \
  -e NEO4J_server_memory_heap_max__size=256m \
  -e NEO4J_server_memory_pagecache_size=128m \
  "$neo4j_image" >/dev/null

for attempt in $(seq 1 60); do
  if docker exec "$restore_container" cypher-shell --format plain -u neo4j -p "$NEO4J_PASSWORD" 'RETURN 1' >/dev/null 2>&1; then
    break
  fi
  [[ "$attempt" -lt 60 ]] || { echo 'FAIL: restored Neo4j database did not become queryable' >&2; exit 1; }
  sleep 2
done

nodes="$(docker exec "$restore_container" cypher-shell --format plain -u neo4j -p "$NEO4J_PASSWORD" \
  'MATCH (n) RETURN count(n) AS nodes' | tr -d '\r' | tail -n 1)"
[[ "$nodes" =~ ^[0-9]+$ && "$nodes" -gt 0 ]] || {
  echo "FAIL: restored Neo4j database contains no graph nodes (nodes=$nodes)" >&2
  exit 1
}

echo "PASS: Neo4j dump loaded and restored database queried successfully (nodes=$nodes) in $workdir"

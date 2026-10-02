# REAmon release runbook

This runbook covers a self-hosted Compose upgrade for the REAmon workspace. Use a
maintenance window for upgrades that change PostgreSQL or Neo4j state. Keep the
release commit, image tag, database dump, and artifact archive together so a
rollback can be reconstructed.

## Preflight

1. Confirm the host has enough disk for a new image and a backup archive.
2. Confirm the deployment is using the intended Compose files. For an
   internet-facing host, use the single-host overlay through its deployment script.
3. Check the rendered configuration without starting anything:

   ```bash
   docker compose config --quiet
   ```

4. Record the current release and service state:

   ```bash
   git rev-parse HEAD
   docker compose ps
   docker image inspect reamon-webapp:production --format '{{.Id}}' || true
   ```

5. Keep `REAMON_DB_PUSH_ACCEPT_DATA_LOSS=false` for the normal upgrade path. The
   image refuses destructive Prisma drift unless an operator explicitly opts in.

## Backup

Set a backup directory outside the repository and retain it according to the
organization's retention policy:

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/var/backups/reamon/$STAMP"
mkdir -p "$BACKUP_DIR"

docker compose exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-redamon}" \
  -d "${POSTGRES_DB:-redamon}" -Fc > "$BACKUP_DIR/postgres.dump"

docker run --rm \
  -v reamon_artifacts:/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine:3.20 tar czf /backup/reamon-artifacts.tar.gz -C /data .
```

Back up Neo4j using the storage provider's volume snapshot or the Neo4j-supported
database dump procedure. If using a Docker volume archive, stop all graph writers
first and resolve the actual volume name with `docker volume ls`; do not assume the
Compose project prefix. Verify that `postgres.dump` and the artifact archive are
non-empty before proceeding.

## Upgrade

1. Fetch and check out the reviewed release commit.
2. Render Compose again and verify the required secrets are present.
3. Build the webapp image, then restart only the webapp and worker services:

   ```bash
   docker compose config --quiet
   docker compose build webapp
   docker compose up -d --no-deps webapp reamon-worker
   ```

4. Wait for readiness and inspect startup logs:

   ```bash
   curl --fail http://127.0.0.1:${WEBAPP_PORT:-3000}/api/health
   curl --fail http://127.0.0.1:${WEBAPP_PORT:-3000}/api/health/ready
   docker compose logs --since=5m webapp reamon-worker
   docker compose ps
   ```

The readiness endpoint must report both PostgreSQL and writable artifact storage as
healthy. A failed readiness check is a release failure; do not route traffic to the
new container while it is unhealthy.

## Planned destructive schema changes

Only after a verified backup and a reviewed schema diff, set
`REAMON_DB_PUSH_ACCEPT_DATA_LOSS=true` for the upgrade command. Record the approval
and exact release commit in the change ticket. Reset it to `false` immediately after
the upgrade. If the guarded schema push fails, investigate the drift instead of
starting the application with a partially synchronized database.

## Rollback and restore

For an application-only regression, redeploy the previous image or release commit
and keep the database unchanged. Do not treat a code rollback as a schema rollback.

For a destructive schema change or corrupted data:

1. Stop webapp, worker, and graph writers.
2. Restore PostgreSQL to an isolated database first and validate the application
   against it before replacing the live volume:

   ```bash
   createdb -U "$POSTGRES_USER" reamon_restore_check
   pg_restore -U "$POSTGRES_USER" -d reamon_restore_check /path/to/postgres.dump
   ```

3. Restore `reamon_artifacts.tar.gz` into the artifact volume only after confirming
   the archive came from the same backup timestamp as the database dump.
4. Restore Neo4j from its matching snapshot or dump.
5. Start the previous release, run the readiness checks, and verify a representative
   workspace, task, observation, and graph query before reopening traffic.

## Exit criteria

- Compose renders without errors and all expected services are healthy.
- `/api/health/ready` returns HTTP 200 with database and artifact checks `ok`.
- No repeated migration, worker, or graph projection errors appear in the last five
  minutes of logs.
- A test workspace can import an artifact, schedule analysis, display its task
  result, and show the resulting observation activity.
- The backup path, release commit, image id, and operator decision are recorded.

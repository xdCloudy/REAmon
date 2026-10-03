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
   scripts/reamon-release-preflight.sh
   ```

   The preflight requires the deployment's normal Compose variables but does not
   print their values. It also checks that the production Dockerfile packages
   the bounded REAmon process-provider tools.

4. Record the current release and service state:

   ```bash
   git rev-parse HEAD
   docker compose ps
   docker image inspect "${REAMON_WEBAPP_IMAGE:-redamon-webapp:latest}" --format '{{.Id}}' || true
   ```

5. Keep `REAMON_DB_PUSH_ACCEPT_DATA_LOSS=false` for the normal upgrade path. The
   image refuses destructive Prisma drift unless an operator explicitly opts in.

   For a staging release, provide `REAMON_DRILL_WEBAPP_URL`,
   `REAMON_DRILL_INTERNAL_KEY`, and a disposable `REAMON_DRILL_PROJECT_ID`, then
   run `scripts/reamon-release-preflight.sh --drill`. The drill sends two concurrent
   dispatches and fails if both claim the same task.

If server-mounted imports are required, set `REAMON_SERVER_SOURCE_ROOTS` to absolute
paths inside the webapp container and add matching read-only bind mounts to the webapp
service. Leave it empty for deployments that only accept browser snapshots. Never
configure a host path that is not mounted into the container; the application fails
closed when a configured root is unavailable.

`REAMON_MAX_RESULT_BYTES` bounds the provider JSON envelope persisted in task and
evidence rows (default 2 MiB, hard-capped at 8 MiB). Oversized provider results are
recorded with a truncation marker while normalized observations still pass through
their own bounded ingestion limits.

`REAMON_IMPORT_RETENTION_DAYS` defaults to 90 days, with a seven-day minimum when
enabled. Retention always preserves the newest completed snapshot for each project
and skips any older snapshot whose artifacts are referenced by tasks, evidence,
findings, observations, or artifact lineage. Set it to `0` to disable pruning.

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

The repository also includes a safe wrapper for repeating this check against an
explicitly different restore database. Run `scripts/reamon-backup-restore-drill.sh
--check` during preflight. In a PostgreSQL tooling environment, set
`REAMON_DRILL_SOURCE_DATABASE_URL`, `REAMON_DRILL_RESTORE_DATABASE_URL`, and
`REAMON_DRILL_ARTIFACT_ROOT`, then run `scripts/reamon-backup-restore-drill.sh --run`.
It refuses to run when source and restore URLs match.

## Import retention and compaction

Run the internal retention job in dry-run mode first. It is bounded to 25 imports
per invocation and does not expose storage paths:

```bash
curl --fail -X POST \
  -H "X-Internal-Key: $INTERNAL_API_KEY" \
  -H 'Content-Type: application/json' \
  "http://127.0.0.1:${WEBAPP_PORT:-3000}/api/internal/reamon/imports/retention" \
  -d '{}'
```

Review the candidate and protected counts, then explicitly apply the same policy
after the PostgreSQL and artifact backups are recorded:

```bash
curl --fail -X POST \
  -H "X-Internal-Key: $INTERNAL_API_KEY" \
  -H 'Content-Type: application/json' \
  "http://127.0.0.1:${WEBAPP_PORT:-3000}/api/internal/reamon/imports/retention" \
  -d '{"apply":true}'
```

Database rows are removed in a transaction before each corresponding artifact byte
is unlinked. A non-empty `storageCleanupFailures` result is an operational warning
that must be resolved before declaring compaction complete; the database remains
authoritative, and the affected volume should be inspected or restored from the
matching artifact backup before the next release.

The private worker invokes the same endpoint on
`REAMON_WORKER_RETENTION_INTERVAL_SECONDS` (default 24 hours). Keep
`REAMON_WORKER_RETENTION_APPLY=false` until the dry-run report has been reviewed;
set it to `true` only for a deployment that has an approved backup and retention
decision.

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

   Verify that the bounded REAmon process providers are present in the actual
   runtime image:

   ```bash
   docker compose exec -T webapp sh -lc 'command -v strings && command -v readelf && command -v file'
   scripts/reamon-release-preflight.sh --live

   docker run --rm --entrypoint sh "${REAMON_WEBAPP_IMAGE:-redamon-webapp:latest}" -lc \
     'test "$(id -u)" = 1001 && command -v strings && command -v readelf && command -v file'
   ```

The readiness endpoint must report both PostgreSQL and writable artifact storage as
healthy. A failed readiness check is a release failure; do not route traffic to the
new container while it is unhealthy.

## Multi-worker drill

The worker service intentionally has no fixed `container_name`, so Compose can run
multiple claimers on one host. In a staging workspace, start two workers and verify
that each has a distinct worker id while a queued task is dispatched only once:

```bash
docker compose up -d --scale reamon-worker=2 reamon-worker
docker compose ps reamon-worker
docker compose logs --since=2m reamon-worker
```

Create one disposable workspace task, wait for it to reach a terminal state, and
confirm the activity stream contains one completion and one graph replay for that
task. Stop one worker during a second disposable task, wait past the configured
stale threshold, and confirm the surviving worker recovers the claim. Tear down
the extra workers after the drill with:

```bash
docker compose up -d --scale reamon-worker=1 reamon-worker
```

For a repeatable API-level assertion against that disposable project, use the
contention drill described in Preflight. It checks worker identity and duplicate
task claims while leaving the task and activity evidence available for operator
inspection.

## Worker alert smoke test

If outbound alerting is enabled, set `REAMON_WORKER_ALERT_WEBHOOK_URL` and, when the
receiver requires it, `REAMON_WORKER_ALERT_WEBHOOK_TOKEN` in the deployment secret
store. Render Compose and confirm the values are present without printing the token:

```bash
docker compose config --quiet
docker compose exec webapp sh -lc 'test -n "$REAMON_WORKER_ALERT_WEBHOOK_URL"'
```

Trigger a disposable provider failure in a non-production workspace and verify that
the receiver gets one `source=reamon`, `event=worker.degraded` JSON event. Confirm
the task-dispatch response and workspace activity still complete if the receiver is
unavailable; webhook delivery is intentionally best-effort with a five-second
timeout. Stale workers are still detected in the dashboard because a stopped worker
cannot deliver its own alert.

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
- The runtime image contains `strings`, `readelf`, and `file` for bounded REAmon providers.
- The release image starts and passes its tool smoke check as the non-root `nextjs`
  user (UID 1001).
- If server-mounted imports are enabled, every configured source root is present as a
  read-only mount and a disposable import rejects symlinks, path escapes, and changed
  files between inventory and ingestion.
- No repeated migration, worker, or graph projection errors appear in the last five
  minutes of logs.
- A test workspace can import an artifact, schedule analysis, review a finding,
  and show the resulting observation/activity records.
- A staging worker contention run has passed, and the backup/restore drill has
  restored PostgreSQL into an isolated target while verifying the artifact archive.
- The backup path, release commit, image id, and operator decision are recorded.

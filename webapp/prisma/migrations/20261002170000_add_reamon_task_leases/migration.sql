-- Give each executor attempt a lease token so stale-task recovery cannot be
-- overwritten by a late response from the abandoned attempt.

ALTER TABLE "reamon_tasks"
  ADD COLUMN "run_token" TEXT;

CREATE INDEX "reamon_tasks_status_started_at_idx"
  ON "reamon_tasks"("status", "started_at");

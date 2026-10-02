-- Record which execution process currently owns a running provider lease.
ALTER TABLE "reamon_tasks" ADD COLUMN "lease_owner" TEXT;

CREATE INDEX "reamon_tasks_status_lease_owner_idx"
  ON "reamon_tasks"("status", "lease_owner");

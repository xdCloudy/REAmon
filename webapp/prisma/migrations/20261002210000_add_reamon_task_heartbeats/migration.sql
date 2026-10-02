-- Keep long-running provider leases alive while they are actively executing.
ALTER TABLE "reamon_tasks" ADD COLUMN "lease_heartbeat_at" TIMESTAMP(3);

CREATE INDEX "reamon_tasks_status_lease_heartbeat_at_idx"
  ON "reamon_tasks"("status", "lease_heartbeat_at");

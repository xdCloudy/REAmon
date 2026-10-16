ALTER TABLE "reamon_code_attempts"
  ADD COLUMN "owner_user_id" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "request_payload" JSONB,
  ADD COLUMN "timeout_ms" INTEGER NOT NULL DEFAULT 120000,
  ADD COLUMN "unit_lease_id" TEXT,
  ADD COLUMN "run_token" TEXT,
  ADD COLUMN "lease_owner" TEXT,
  ADD COLUMN "lease_heartbeat_at" TIMESTAMP(3);

ALTER TABLE "reamon_code_attempts" ALTER COLUMN "status" SET DEFAULT 'QUEUED';

CREATE INDEX "reamon_code_attempts_status_created_at_idx"
  ON "reamon_code_attempts"("status", "created_at");
CREATE INDEX "reamon_code_attempts_status_lease_heartbeat_at_idx"
  ON "reamon_code_attempts"("status", "lease_heartbeat_at");

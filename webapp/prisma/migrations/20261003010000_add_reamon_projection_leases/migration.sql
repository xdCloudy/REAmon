-- Fence paginated graph projection runs so concurrent historical backfills
-- cannot delete each other's still-in-flight graph writes during reconciliation.
ALTER TABLE "reamon_projection_runs"
  ADD COLUMN "reconciled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deleted_nodes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deleted_relationships" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "reamon_projection_leases" (
    "project_id" TEXT NOT NULL,
    "projection_run_id" TEXT NOT NULL,
    "lease_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reamon_projection_leases_pkey" PRIMARY KEY ("project_id")
);

CREATE UNIQUE INDEX "reamon_projection_leases_projection_run_id_key"
  ON "reamon_projection_leases"("projection_run_id");
CREATE INDEX "reamon_projection_leases_lease_until_idx"
  ON "reamon_projection_leases"("lease_until");
ALTER TABLE "reamon_projection_leases"
  ADD CONSTRAINT "reamon_projection_leases_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;

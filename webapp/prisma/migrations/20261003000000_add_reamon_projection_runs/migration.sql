CREATE TABLE "reamon_projection_runs" (
    "id" TEXT NOT NULL,
    "projection_run_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "offset" INTEGER NOT NULL DEFAULT 0,
    "selected" INTEGER NOT NULL DEFAULT 0,
    "nodes" INTEGER NOT NULL DEFAULT 0,
    "relationships" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT NOT NULL DEFAULT '',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reamon_projection_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reamon_projection_runs_projection_run_id_key" ON "reamon_projection_runs"("projection_run_id");
CREATE INDEX "reamon_projection_runs_project_id_started_at_idx" ON "reamon_projection_runs"("project_id", "started_at");
CREATE INDEX "reamon_projection_runs_status_started_at_idx" ON "reamon_projection_runs"("status", "started_at");

ALTER TABLE "reamon_projection_runs" ADD CONSTRAINT "reamon_projection_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

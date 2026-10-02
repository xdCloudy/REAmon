-- Normalize provider output into a project-scoped, retry-safe observation
-- store. This is the relational source for workspace queries and future graph
-- projection.

CREATE TABLE "reamon_observations" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "task_id" TEXT,
    "target_id" TEXT,
    "artifact_id" TEXT,
    "kind" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "stable_key" TEXT NOT NULL,
    "label" TEXT,
    "source" TEXT NOT NULL,
    "relation" TEXT,
    "from_key" TEXT,
    "to_key" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reamon_observations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reamon_observations_project_id_source_stable_key_key"
  ON "reamon_observations"("project_id", "source", "stable_key");
CREATE INDEX "reamon_observations_project_id_kind_type_idx"
  ON "reamon_observations"("project_id", "kind", "type");
CREATE INDEX "reamon_observations_project_id_task_id_idx"
  ON "reamon_observations"("project_id", "task_id");
CREATE INDEX "reamon_observations_project_id_artifact_id_idx"
  ON "reamon_observations"("project_id", "artifact_id");

ALTER TABLE "reamon_observations"
  ADD CONSTRAINT "reamon_observations_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "reamon_observations_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "reamon_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "reamon_observations_target_id_fkey"
  FOREIGN KEY ("target_id") REFERENCES "reamon_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "reamon_observations_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "reamon_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

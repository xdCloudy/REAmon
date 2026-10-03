CREATE TABLE "reamon_artifact_provenance" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "source_artifact_id" TEXT NOT NULL,
    "task_id" TEXT,
    "relation" TEXT NOT NULL DEFAULT 'DERIVED_FROM',
    "provenance_key" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reamon_artifact_provenance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reamon_artifact_provenance_provenance_key_key" ON "reamon_artifact_provenance"("provenance_key");
CREATE INDEX "reamon_artifact_provenance_project_id_artifact_id_idx" ON "reamon_artifact_provenance"("project_id", "artifact_id");
CREATE INDEX "reamon_artifact_provenance_project_id_source_artifact_id_idx" ON "reamon_artifact_provenance"("project_id", "source_artifact_id");
CREATE INDEX "reamon_artifact_provenance_project_id_task_id_idx" ON "reamon_artifact_provenance"("project_id", "task_id");

ALTER TABLE "reamon_artifact_provenance" ADD CONSTRAINT "reamon_artifact_provenance_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reamon_artifact_provenance" ADD CONSTRAINT "reamon_artifact_provenance_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "reamon_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reamon_artifact_provenance" ADD CONSTRAINT "reamon_artifact_provenance_source_artifact_id_fkey" FOREIGN KEY ("source_artifact_id") REFERENCES "reamon_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reamon_artifact_provenance" ADD CONSTRAINT "reamon_artifact_provenance_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "reamon_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

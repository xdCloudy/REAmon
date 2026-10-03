ALTER TABLE "reamon_findings" ADD COLUMN "task_id" TEXT;
ALTER TABLE "reamon_findings" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'system';
ALTER TABLE "reamon_findings" ADD COLUMN "stable_key" TEXT;
ALTER TABLE "reamon_findings" ADD COLUMN "data" JSONB NOT NULL DEFAULT '{}';

CREATE INDEX "reamon_findings_project_id_task_id_idx" ON "reamon_findings"("project_id", "task_id");
CREATE INDEX "reamon_findings_project_id_source_idx" ON "reamon_findings"("project_id", "source");

ALTER TABLE "reamon_findings" ADD CONSTRAINT "reamon_findings_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "reamon_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

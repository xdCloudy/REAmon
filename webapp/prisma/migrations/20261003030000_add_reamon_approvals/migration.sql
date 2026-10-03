CREATE TABLE "reamon_approvals" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requested_by" TEXT NOT NULL DEFAULT 'system',
    "decided_by" TEXT,
    "reason" TEXT NOT NULL DEFAULT '',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reamon_approvals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reamon_approvals_task_id_key" ON "reamon_approvals"("task_id");
CREATE INDEX "reamon_approvals_project_id_status_idx" ON "reamon_approvals"("project_id", "status");
CREATE INDEX "reamon_approvals_project_id_created_at_idx" ON "reamon_approvals"("project_id", "created_at");

ALTER TABLE "reamon_approvals" ADD CONSTRAINT "reamon_approvals_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reamon_approvals" ADD CONSTRAINT "reamon_approvals_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "reamon_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

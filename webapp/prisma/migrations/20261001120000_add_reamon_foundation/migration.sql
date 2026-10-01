-- REAmon foundation: generic investigation entities alongside the legacy
-- RedAmon Project/settings tables. Project is the workspace root for now.

CREATE TABLE "reamon_targets" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target_type" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "locator" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "profile" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reamon_targets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reamon_artifacts" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "target_id" TEXT,
    "name" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "extension" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "profile" JSONB NOT NULL DEFAULT '{}',
    "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reamon_artifacts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reamon_tasks" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "target_id" TEXT,
    "artifact_id" TEXT,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'analysis',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reamon_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reamon_findings" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "target_id" TEXT,
    "artifact_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "severity" TEXT NOT NULL DEFAULT 'info',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reamon_findings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reamon_hypotheses" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "target_id" TEXT,
    "artifact_id" TEXT,
    "statement" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reamon_hypotheses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reamon_evidence" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "target_id" TEXT,
    "artifact_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'observation',
    "summary" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'system',
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reamon_evidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reamon_workspace_activities" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "event_type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reamon_workspace_activities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reamon_targets_project_id_status_idx" ON "reamon_targets"("project_id", "status");
CREATE INDEX "reamon_targets_project_id_target_type_idx" ON "reamon_targets"("project_id", "target_type");
CREATE INDEX "reamon_artifacts_project_id_status_idx" ON "reamon_artifacts"("project_id", "status");
CREATE INDEX "reamon_artifacts_project_id_sha256_idx" ON "reamon_artifacts"("project_id", "sha256");
CREATE INDEX "reamon_artifacts_target_id_idx" ON "reamon_artifacts"("target_id");
CREATE INDEX "reamon_tasks_project_id_status_idx" ON "reamon_tasks"("project_id", "status");
CREATE INDEX "reamon_tasks_project_id_category_idx" ON "reamon_tasks"("project_id", "category");
CREATE INDEX "reamon_findings_project_id_status_idx" ON "reamon_findings"("project_id", "status");
CREATE INDEX "reamon_findings_project_id_severity_idx" ON "reamon_findings"("project_id", "severity");
CREATE INDEX "reamon_hypotheses_project_id_status_idx" ON "reamon_hypotheses"("project_id", "status");
CREATE INDEX "reamon_evidence_project_id_created_at_idx" ON "reamon_evidence"("project_id", "created_at");
CREATE INDEX "reamon_evidence_target_id_idx" ON "reamon_evidence"("target_id");
CREATE INDEX "reamon_evidence_artifact_id_idx" ON "reamon_evidence"("artifact_id");
CREATE INDEX "reamon_workspace_activities_project_id_created_at_idx" ON "reamon_workspace_activities"("project_id", "created_at");

ALTER TABLE "reamon_targets" ADD CONSTRAINT "reamon_targets_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reamon_artifacts" ADD CONSTRAINT "reamon_artifacts_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reamon_artifacts" ADD CONSTRAINT "reamon_artifacts_target_id_fkey"
  FOREIGN KEY ("target_id") REFERENCES "reamon_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reamon_tasks" ADD CONSTRAINT "reamon_tasks_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reamon_tasks" ADD CONSTRAINT "reamon_tasks_target_id_fkey"
  FOREIGN KEY ("target_id") REFERENCES "reamon_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reamon_tasks" ADD CONSTRAINT "reamon_tasks_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "reamon_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reamon_findings" ADD CONSTRAINT "reamon_findings_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reamon_findings" ADD CONSTRAINT "reamon_findings_target_id_fkey"
  FOREIGN KEY ("target_id") REFERENCES "reamon_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reamon_findings" ADD CONSTRAINT "reamon_findings_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "reamon_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reamon_hypotheses" ADD CONSTRAINT "reamon_hypotheses_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reamon_hypotheses" ADD CONSTRAINT "reamon_hypotheses_target_id_fkey"
  FOREIGN KEY ("target_id") REFERENCES "reamon_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reamon_hypotheses" ADD CONSTRAINT "reamon_hypotheses_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "reamon_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reamon_evidence" ADD CONSTRAINT "reamon_evidence_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reamon_evidence" ADD CONSTRAINT "reamon_evidence_target_id_fkey"
  FOREIGN KEY ("target_id") REFERENCES "reamon_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reamon_evidence" ADD CONSTRAINT "reamon_evidence_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "reamon_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reamon_workspace_activities" ADD CONSTRAINT "reamon_workspace_activities_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

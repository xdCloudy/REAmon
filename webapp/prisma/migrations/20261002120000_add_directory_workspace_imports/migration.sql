-- REAmon directory-first workspace imports. All changes are additive so
-- existing RedAmon projects and single-file artifacts remain readable.

ALTER TABLE "projects"
  ADD COLUMN "project_kind" TEXT NOT NULL DEFAULT 'LEGACY_SECURITY';

ALTER TABLE "reamon_targets"
  ADD COLUMN "parent_target_id" TEXT;

ALTER TABLE "reamon_artifacts"
  ADD COLUMN "import_id" TEXT,
  ADD COLUMN "relative_path" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "parent_path" TEXT NOT NULL DEFAULT '';

-- Old single-file rows have no logical path in the original schema. The
-- original name is the safest migration fallback; it is never used as a disk
-- path by the storage layer.
UPDATE "reamon_artifacts"
SET "relative_path" = "original_name"
WHERE "relative_path" = '';

CREATE TABLE "reamon_workspace_imports" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "root_target_id" TEXT,
  "source_type" TEXT NOT NULL DEFAULT 'BROWSER_DIRECTORY',
  "root_name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "total_files" INTEGER NOT NULL DEFAULT 0,
  "completed_files" INTEGER NOT NULL DEFAULT 0,
  "failed_files" INTEGER NOT NULL DEFAULT 0,
  "total_bytes" BIGINT NOT NULL DEFAULT 0,
  "uploaded_bytes" BIGINT NOT NULL DEFAULT 0,
  "manifest" JSONB NOT NULL DEFAULT '[]',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "error_summary" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "reamon_workspace_imports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reamon_workspace_imports_root_target_id_key"
  ON "reamon_workspace_imports"("root_target_id");
CREATE INDEX "reamon_workspace_imports_project_id_status_idx"
  ON "reamon_workspace_imports"("project_id", "status");
CREATE INDEX "reamon_workspace_imports_project_id_created_at_idx"
  ON "reamon_workspace_imports"("project_id", "created_at");
CREATE INDEX "reamon_targets_parent_target_id_idx"
  ON "reamon_targets"("parent_target_id");
CREATE INDEX "reamon_artifacts_project_id_relative_path_idx"
  ON "reamon_artifacts"("project_id", "relative_path");
CREATE INDEX "reamon_artifacts_import_id_relative_path_idx"
  ON "reamon_artifacts"("import_id", "relative_path");

ALTER TABLE "reamon_targets"
  ADD CONSTRAINT "reamon_targets_parent_target_id_fkey"
  FOREIGN KEY ("parent_target_id") REFERENCES "reamon_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reamon_artifacts"
  ADD CONSTRAINT "reamon_artifacts_import_id_fkey"
  FOREIGN KEY ("import_id") REFERENCES "reamon_workspace_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reamon_workspace_imports"
  ADD CONSTRAINT "reamon_workspace_imports_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "reamon_workspace_imports_root_target_id_fkey"
  FOREIGN KEY ("root_target_id") REFERENCES "reamon_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

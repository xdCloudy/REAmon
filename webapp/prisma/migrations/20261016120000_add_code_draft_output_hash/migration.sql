ALTER TABLE "reamon_code_drafts"
  ADD COLUMN "draft_hash" TEXT;

CREATE INDEX "reamon_code_drafts_hash_validation_idx"
  ON "reamon_code_drafts"("project_id", "artifact_id", "draft_hash", "validation_status");

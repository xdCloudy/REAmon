ALTER TABLE "reamon_evidence"
ADD COLUMN "source_reference" TEXT;

CREATE UNIQUE INDEX "reamon_evidence_project_id_source_source_reference_key"
ON "reamon_evidence"("project_id", "source", "source_reference");

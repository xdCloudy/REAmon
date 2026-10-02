-- Give observations an explicit identity key so providers can converge on the
-- same graph entity without losing their source-specific stable key.

ALTER TABLE "reamon_observations"
  ADD COLUMN "canonical_key" TEXT;

UPDATE "reamon_observations"
SET "canonical_key" = "source" || ':' || "stable_key"
WHERE "canonical_key" IS NULL;

ALTER TABLE "reamon_observations"
  ALTER COLUMN "canonical_key" SET NOT NULL;

CREATE INDEX "reamon_observations_project_id_canonical_key_idx"
  ON "reamon_observations"("project_id", "canonical_key");

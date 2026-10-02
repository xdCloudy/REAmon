-- Persist provider manifests and make analysis proposals schedulable. The
-- execution worker is intentionally separate: scheduling only creates a
-- durable QUEUED task and never runs a provider in the request.

CREATE TABLE "reamon_providers" (
    "id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "integration" TEXT NOT NULL,
    "accepts_target_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "accepts_formats" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "produces" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "requirements" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" TEXT NOT NULL DEFAULT '1',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reamon_providers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reamon_providers_plugin_id_key"
  ON "reamon_providers"("plugin_id");
CREATE INDEX "reamon_providers_enabled_idx"
  ON "reamon_providers"("enabled");

ALTER TABLE "reamon_tasks"
  ADD COLUMN "provider_id" TEXT,
  ADD COLUMN "capability" TEXT,
  ADD COLUMN "options" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "result" JSONB,
  ADD COLUMN "error" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "idempotency_key" TEXT,
  ADD COLUMN "started_at" TIMESTAMP(3),
  ADD COLUMN "completed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "reamon_tasks_idempotency_key_key"
  ON "reamon_tasks"("idempotency_key");
CREATE INDEX "reamon_tasks_project_id_provider_id_capability_idx"
  ON "reamon_tasks"("project_id", "provider_id", "capability");

ALTER TABLE "reamon_tasks"
  ADD CONSTRAINT "reamon_tasks_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "reamon_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

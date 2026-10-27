CREATE TABLE "reamon_artifact_storage_cleanup" (
    "id" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reamon_artifact_storage_cleanup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reamon_artifact_storage_cleanup_storage_path_key"
    ON "reamon_artifact_storage_cleanup"("storage_path");

CREATE INDEX "reamon_artifact_storage_cleanup_created_at_idx"
    ON "reamon_artifact_storage_cleanup"("created_at");

CREATE TABLE "reamon_workers" (
    "id" TEXT NOT NULL,
    "worker_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "last_dispatch_at" TIMESTAMP(3),
    "last_dispatch_duration_ms" INTEGER,
    "last_recovered" INTEGER NOT NULL DEFAULT 0,
    "last_selected" INTEGER NOT NULL DEFAULT 0,
    "last_completed" INTEGER NOT NULL DEFAULT 0,
    "last_failed" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reamon_workers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reamon_workers_worker_id_key" ON "reamon_workers"("worker_id");
CREATE INDEX "reamon_workers_status_last_seen_at_idx" ON "reamon_workers"("status", "last_seen_at");

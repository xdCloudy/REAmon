CREATE TABLE "reamon_function_queue_states" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "artifact_id" TEXT NOT NULL,
  "state" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reamon_function_queue_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reamon_function_queue_states_task_id_key" UNIQUE ("task_id"),
  CONSTRAINT "reamon_function_queue_states_project_id_task_id_key" UNIQUE ("project_id", "task_id"),
  CONSTRAINT "reamon_function_queue_states_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "reamon_function_queue_states_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "reamon_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "reamon_function_queue_states_project_id_artifact_id_idx"
  ON "reamon_function_queue_states"("project_id", "artifact_id");

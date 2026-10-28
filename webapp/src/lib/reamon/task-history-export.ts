export interface ProjectTaskHistoryExportRow {
  id: string
  targetId: string | null
  artifactId: string | null
  capability: string | null
  title: string
  category: string
  status: string
  progress: number
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
  provider: { pluginId: string } | null
}

export interface SerializedProjectTaskHistory extends Omit<ProjectTaskHistoryExportRow, 'startedAt' | 'completedAt' | 'createdAt' | 'updatedAt' | 'provider'> {
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  providerPluginId: string | null
}

/** Export only display-safe history fields; never include options or result payloads. */
export function serializeProjectTaskHistory(rows: ProjectTaskHistoryExportRow[]): SerializedProjectTaskHistory[] {
  return rows.map(task => ({
    id: task.id,
    targetId: task.targetId,
    artifactId: task.artifactId,
    capability: task.capability,
    title: task.title,
    category: task.category,
    status: task.status,
    progress: task.progress,
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    providerPluginId: task.provider?.pluginId ?? null,
  }))
}

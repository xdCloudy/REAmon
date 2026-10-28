import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'

export const MAX_IMPORTED_TASK_HISTORY = 50_000

export interface PreparedTaskHistoryRow {
  id: string
  projectId: string
  targetId: null
  artifactId: null
  providerId: null
  capability: string | null
  title: string
  category: string
  status: 'IMPORTED'
  progress: 0
  progressMessage: string
  options: Prisma.InputJsonValue
  error: ''
  runToken: null
  idempotencyKey: null
  startedAt: Date | null
  leaseHeartbeatAt: null
  leaseOwner: null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface PreparedTaskHistoryImport {
  rows: PreparedTaskHistoryRow[]
  idMap: Map<string, string>
  skipped: number
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function importedDate(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string') return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date
}

function optionalImportedDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Recreate task evidence as inert history, never as runnable or approved work. */
export function prepareTaskHistoryImport(
  value: unknown,
  projectId: string,
  now = new Date(),
): PreparedTaskHistoryImport {
  if (!Array.isArray(value)) return { rows: [], idMap: new Map(), skipped: 0 }

  const idMap = new Map<string, string>()
  const rows: PreparedTaskHistoryRow[] = []
  let skipped = Math.max(0, value.length - MAX_IMPORTED_TASK_HISTORY)

  for (const raw of value.slice(0, MAX_IMPORTED_TASK_HISTORY)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped++
      continue
    }
    const source = raw as Record<string, unknown>
    const sourceId = boundedString(source.id, 200)
    const title = boundedString(source.title, 500)
    const category = boundedString(source.category, 120)
    if (!sourceId || !/^[a-zA-Z0-9_-]+$/.test(sourceId) || !title || !category || idMap.has(sourceId)) {
      skipped++
      continue
    }

    const id = randomUUID()
    idMap.set(sourceId, id)
    const createdAt = importedDate(source.createdAt, now)
    const updatedAt = importedDate(source.updatedAt, createdAt)
    rows.push({
      id,
      projectId,
      targetId: null,
      artifactId: null,
      providerId: null,
      capability: boundedString(source.capability, 120),
      title,
      category,
      status: 'IMPORTED',
      progress: 0,
      progressMessage: 'Imported historical record; this task cannot execute.',
      options: {
        importOrigin: {
          taskId: sourceId,
          targetId: boundedString(source.targetId, 200),
          artifactId: boundedString(source.artifactId, 200),
          providerPluginId: boundedString(source.providerPluginId, 200),
          status: boundedString(source.status, 80),
          progress: typeof source.progress === 'number' && Number.isFinite(source.progress)
            ? Math.max(0, Math.min(100, Math.floor(source.progress)))
            : null,
        },
      },
      error: '',
      runToken: null,
      idempotencyKey: null,
      startedAt: optionalImportedDate(source.startedAt),
      leaseHeartbeatAt: null,
      leaseOwner: null,
      completedAt: optionalImportedDate(source.completedAt),
      createdAt,
      updatedAt,
    })
  }

  return { rows, idMap, skipped }
}

import prisma from '@/lib/prisma'
import { executeAnalysisTask, type ExecutedAnalysisTask } from './task-executor'

const DEFAULT_BATCH_SIZE = 1
const MAX_BATCH_SIZE = 10

export interface DispatchQueuedTaskInput {
  projectId?: string
  limit?: number
}

export interface DispatchQueuedTaskResult {
  requested: number
  selected: number
  results: ExecutedAnalysisTask[]
}

function normaliseLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_SIZE
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(value as number)))
}

export async function dispatchQueuedAnalysisTasks(input: DispatchQueuedTaskInput = {}): Promise<DispatchQueuedTaskResult> {
  const limit = normaliseLimit(input.limit)
  const queued = await prisma.task.findMany({
    where: { status: 'QUEUED', ...(input.projectId ? { projectId: input.projectId } : {}) },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, projectId: true },
  })
  const results: ExecutedAnalysisTask[] = []
  for (const task of queued) {
    const result = await executeAnalysisTask(task.projectId, task.id)
    if (result) results.push(result)
  }
  return { requested: limit, selected: queued.length, results }
}

import prisma from '@/lib/prisma'
import { executeAnalysisTask, type ExecutedAnalysisTask } from './task-executor'

const DEFAULT_BATCH_SIZE = 1
const MAX_BATCH_SIZE = 10

export interface DispatchQueuedTaskInput {
  projectId?: string
  limit?: number
  workerId?: string
}

export interface DispatchQueuedTaskResult {
  requested: number
  selected: number
  workerId: string
  results: ExecutedAnalysisTask[]
}

function normaliseLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_SIZE
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(value as number)))
}

export async function dispatchQueuedAnalysisTasks(input: DispatchQueuedTaskInput = {}): Promise<DispatchQueuedTaskResult> {
  const limit = normaliseLimit(input.limit)
  const workerId = input.workerId?.trim().slice(0, 128) || 'internal-dispatch'
  const results: ExecutedAnalysisTask[] = []
  const skippedTaskIds = new Set<string>()
  let selected = 0
  // A concurrent dispatcher can read the same queued row just before another
  // worker claims it. Refill after a lost claim so the loser continues to the
  // next queued task instead of returning a misleading duplicate task result.
  // The attempt bound keeps a pathological stream of racing claims finite.
  const maxAttempts = Math.max(limit * 3, limit + 2)
  let attempts = 0
  while (results.length < limit && attempts < maxAttempts) {
    const queued = await prisma.task.findMany({
      where: {
        status: 'QUEUED',
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(skippedTaskIds.size > 0 ? { id: { notIn: [...skippedTaskIds] } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: Math.min(limit - results.length, maxAttempts - attempts),
      select: { id: true, projectId: true },
    })
    if (!queued.length) break
    selected += queued.length
    let hadSkippedClaim = false
    for (const task of queued) {
      attempts += 1
      const result = await executeAnalysisTask(task.projectId, task.id, workerId)
      if (!result) break
      if (result.outcome === 'SKIPPED') {
        skippedTaskIds.add(task.id)
        hadSkippedClaim = true
        continue
      }
      results.push(result)
      if (results.length >= limit || attempts >= maxAttempts) break
    }
    if (!hadSkippedClaim) break
  }
  return { requested: limit, selected, workerId, results }
}

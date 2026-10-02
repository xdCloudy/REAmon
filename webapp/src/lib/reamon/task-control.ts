import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'

const taskSelect = {
  id: true,
  title: true,
  status: true,
  progress: true,
  error: true,
  runToken: true,
  startedAt: true,
  leaseHeartbeatAt: true,
  leaseOwner: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TaskSelect

const staleTaskSelect = {
  id: true,
  projectId: true,
  title: true,
  runToken: true,
  startedAt: true,
  leaseHeartbeatAt: true,
  leaseOwner: true,
} satisfies Prisma.TaskSelect

type TaskControlRow = Prisma.TaskGetPayload<{ select: typeof taskSelect }>
type StaleTaskRow = Prisma.TaskGetPayload<{ select: typeof staleTaskSelect }>

export type TaskControlResult = {
  outcome: 'REQUEUED' | 'CANCELLED' | 'SKIPPED'
  task: {
    id: string
    title: string
    status: string
    progress: number
    error: string
    startedAt: string | null
    leaseHeartbeatAt: string | null
    leaseOwner: string | null
    completedAt: string | null
    createdAt: string
    updatedAt: string
  }
}

function serialiseTask(task: TaskControlRow): TaskControlResult['task'] {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    progress: task.progress,
    error: task.error,
    startedAt: task.startedAt?.toISOString() || null,
    leaseHeartbeatAt: task.leaseHeartbeatAt?.toISOString() || null,
    leaseOwner: task.leaseOwner,
    completedAt: task.completedAt?.toISOString() || null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  }
}

async function loadTask(projectId: string, taskId: string): Promise<TaskControlRow | null> {
  return prisma.task.findFirst({ where: { id: taskId, projectId }, select: taskSelect })
}

export async function retryAnalysisTask(projectId: string, taskId: string): Promise<TaskControlResult | null> {
  const task = await loadTask(projectId, taskId)
  if (!task) return null
  if (task.status !== 'FAILED' && task.status !== 'CANCELLED') {
    return { outcome: 'SKIPPED', task: serialiseTask(task) }
  }

  const requeued = await prisma.$transaction(async (tx) => {
    const claimed = await tx.task.updateMany({
      where: { id: taskId, projectId, status: { in: ['FAILED', 'CANCELLED'] } },
      data: {
        status: 'QUEUED',
        progress: 0,
        result: Prisma.JsonNull,
        error: '',
        startedAt: null,
        leaseHeartbeatAt: null,
        leaseOwner: null,
        completedAt: null,
        runToken: null,
      },
    })
    if (claimed.count !== 1) return null

    const updated = await tx.task.findUnique({ where: { id: taskId }, select: taskSelect })
    if (!updated) return null

    await tx.workspaceActivity.create({
      data: {
        projectId,
        actor: 'Operator',
        eventType: 'analysis.task.requeued',
        message: `Requeued ${updated.title} for another execution attempt`,
        data: { taskId, reason: 'manual_retry' },
      },
    })
    return updated
  })

  if (!requeued) {
    const current = await loadTask(projectId, taskId)
    return current ? { outcome: 'SKIPPED', task: serialiseTask(current) } : null
  }
  return { outcome: 'REQUEUED', task: serialiseTask(requeued) }
}

export async function cancelAnalysisTask(projectId: string, taskId: string): Promise<TaskControlResult | null> {
  const task = await loadTask(projectId, taskId)
  if (!task) return null
  if (task.status !== 'QUEUED' && task.status !== 'RUNNING') {
    return { outcome: 'SKIPPED', task: serialiseTask(task) }
  }

  const cancelledAt = new Date()
  const cancelled = await prisma.$transaction(async (tx) => {
    const updated = await tx.task.updateMany({
      where: { id: taskId, projectId, status: { in: ['QUEUED', 'RUNNING'] }, runToken: task.runToken },
      data: {
        status: 'CANCELLED',
        progress: task.status === 'QUEUED' ? 0 : task.progress,
        result: Prisma.JsonNull,
        error: 'Cancelled by operator',
        startedAt: task.status === 'QUEUED' ? null : task.startedAt,
        leaseHeartbeatAt: null,
        leaseOwner: null,
        completedAt: cancelledAt,
        runToken: null,
      },
    })
    if (updated.count !== 1) return null

    const current = await tx.task.findUnique({ where: { id: taskId }, select: taskSelect })
    if (!current) return null
    await tx.workspaceActivity.create({
      data: {
        projectId,
        actor: 'Operator',
        eventType: 'analysis.task.cancelled',
        message: `Cancelled ${current.title}`,
        data: { taskId, previousStatus: task.status },
      },
    })
    return current
  })

  if (!cancelled) {
    const current = await loadTask(projectId, taskId)
    return current ? { outcome: 'SKIPPED', task: serialiseTask(current) } : null
  }
  return { outcome: 'CANCELLED', task: serialiseTask(cancelled) }
}

function normaliseStaleAfterMinutes(value: number | undefined): number {
  if (!Number.isFinite(value)) return 30
  return Math.min(24 * 60, Math.max(5, Math.floor(value as number)))
}

export async function recoverStaleAnalysisTasks(projectId: string | undefined, requestedMinutes?: number, recoveredBy?: string) {
  const staleAfterMinutes = normaliseStaleAfterMinutes(requestedMinutes)
  const cutoff = new Date(Date.now() - staleAfterMinutes * 60 * 1000)
  const candidates = await prisma.task.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      status: 'RUNNING',
      OR: [
        { leaseHeartbeatAt: { not: null, lt: cutoff } },
        { leaseHeartbeatAt: null, startedAt: { not: null, lt: cutoff } },
      ],
    },
    select: staleTaskSelect,
    orderBy: { startedAt: 'asc' },
  })

  if (!candidates.length) return { recovered: 0, staleAfterMinutes, cutoff: cutoff.toISOString() }

  const recovered = await prisma.$transaction(async (tx) => {
    let count = 0
    for (const task of candidates) {
      const updated = await tx.task.updateMany({
        where: { id: task.id, ...(projectId ? { projectId } : {}), status: 'RUNNING', runToken: task.runToken },
        data: {
          status: 'QUEUED',
          progress: 0,
          result: Prisma.JsonNull,
          error: `Recovered after ${staleAfterMinutes} minutes without completion`,
          startedAt: null,
          leaseHeartbeatAt: null,
          leaseOwner: null,
          completedAt: null,
          runToken: null,
        },
      })
      if (updated.count !== 1) continue
      count += 1
      await tx.workspaceActivity.create({
        data: {
          projectId: task.projectId,
          actor: 'Operator',
          eventType: 'analysis.task.recovered',
          message: `Recovered stale task ${task.title}; it is queued for a safe retry`,
          data: {
            taskId: task.id,
            staleAfterMinutes,
            startedAt: task.startedAt?.toISOString() || null,
            leaseHeartbeatAt: task.leaseHeartbeatAt?.toISOString() || null,
            leaseOwner: task.leaseOwner,
            recoveredBy: recoveredBy?.trim().slice(0, 128) || null,
          },
        },
      })
    }
    return count
  })

  return { recovered, staleAfterMinutes, cutoff: cutoff.toISOString() }
}

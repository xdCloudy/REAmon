import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import prisma from '@/lib/prisma'
import { getBuiltinProvider } from './provider-registry'
import { resolveCapabilities } from './capabilities'
import { ingestToolResult } from './result-ingestion'
import type { TargetProfile, ToolResult } from './types'

const DEFAULT_LEASE_OWNER = 'webapp'
const MAX_LEASE_OWNER_LENGTH = 128

const taskSelect = {
  id: true,
  projectId: true,
  targetId: true,
  artifactId: true,
  providerId: true,
  capability: true,
  title: true,
  category: true,
  status: true,
  progress: true,
  options: true,
  result: true,
  error: true,
  runToken: true,
  startedAt: true,
  leaseHeartbeatAt: true,
  leaseOwner: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  provider: { select: { id: true, pluginId: true, name: true, enabled: true } },
  artifact: { select: { id: true, targetId: true, relativePath: true, profile: true } },
} satisfies Prisma.TaskSelect

type TaskRow = Prisma.TaskGetPayload<{ select: typeof taskSelect }>

export interface ExecutedAnalysisTask {
  outcome: 'COMPLETED' | 'FAILED' | 'SKIPPED'
  task: {
    id: string
    projectId: string
    targetId: string | null
    artifactId: string | null
    providerId: string | null
    capability: string | null
    title: string
    category: string
    status: string
    progress: number
    result: unknown
    error: string
    startedAt: string | null
    leaseHeartbeatAt: string | null
    leaseOwner: string | null
    completedAt: string | null
    createdAt: string
    updatedAt: string
  }
}

function serialiseTask(task: TaskRow): ExecutedAnalysisTask['task'] {
  return {
    id: task.id,
    projectId: task.projectId,
    targetId: task.targetId,
    artifactId: task.artifactId,
    providerId: task.providerId,
    capability: task.capability,
    title: task.title,
    category: task.category,
    status: task.status,
    progress: task.progress,
    result: task.result,
    error: task.error,
    startedAt: task.startedAt?.toISOString() || null,
    leaseHeartbeatAt: task.leaseHeartbeatAt?.toISOString() || null,
    leaseOwner: task.leaseOwner,
    completedAt: task.completedAt?.toISOString() || null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  }
}

function asOptions(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function boundedError(value: string): string {
  return value.trim().slice(0, 4000) || 'Provider execution failed'
}

function heartbeatIntervalMs(): number {
  const raw = Number(process.env.REAMON_TASK_HEARTBEAT_SECONDS)
  const seconds = Number.isFinite(raw) ? Math.min(300, Math.max(5, Math.floor(raw))) : 60
  return seconds * 1000
}

function normaliseLeaseOwner(value: string | undefined): string {
  const owner = value?.trim() || DEFAULT_LEASE_OWNER
  return owner.slice(0, MAX_LEASE_OWNER_LENGTH)
}

function startTaskHeartbeat(
  projectId: string,
  taskId: string,
  runToken: string,
  controller: AbortController,
): () => void {
  let updateInFlight = false
  const refresh = () => {
    if (updateInFlight) return
    updateInFlight = true
    void prisma.task.findFirst({
      where: { id: taskId, projectId, status: 'CANCELLED' },
      select: { id: true, status: true },
    }).catch(() => null).then((cancelled) => {
      if (cancelled?.status === 'CANCELLED') {
        controller.abort()
        return null
      }
      return prisma.task.updateMany({
        where: { id: taskId, projectId, status: 'RUNNING', runToken },
        data: { leaseHeartbeatAt: new Date() },
      })
    }).catch(() => undefined).finally(() => {
      updateInFlight = false
    })
  }
  refresh()
  const interval = setInterval(refresh, heartbeatIntervalMs())
  interval.unref?.()
  return () => clearInterval(interval)
}

async function loadTask(projectId: string, taskId: string): Promise<TaskRow | null> {
  return prisma.task.findFirst({ where: { id: taskId, projectId }, select: taskSelect })
}

async function settleTask(
  task: TaskRow,
  runToken: string,
  outcome: 'COMPLETED' | 'FAILED',
  providerName: string,
  result?: ToolResult,
  failure?: string,
): Promise<ExecutedAnalysisTask> {
  const error = boundedError(failure || result?.error || '')
  const completedAt = new Date()
  const updated = await prisma.$transaction(async (tx) => {
    const claim = await tx.task.updateMany({
      where: { id: task.id, projectId: task.projectId, status: 'RUNNING', runToken },
      data: {
        status: outcome,
        progress: outcome === 'COMPLETED' ? 100 : task.progress,
        result: result?.data === undefined ? undefined : result.data as unknown as Prisma.InputJsonValue,
        error: outcome === 'COMPLETED' ? '' : error,
        leaseHeartbeatAt: null,
        leaseOwner: null,
        completedAt,
      },
    })
    if (claim.count !== 1) return null

    const updatedTask = await tx.task.findUnique({ where: { id: task.id }, select: taskSelect })
    if (!updatedTask) return null

    let observationSummary = { accepted: 0, rejected: 0 }
    if (outcome === 'COMPLETED' && result) {
      await tx.evidence.create({
        data: {
          projectId: task.projectId,
          targetId: task.targetId,
          artifactId: task.artifactId,
          kind: 'analysis',
          summary: `${providerName} completed ${task.capability || 'analysis'}`,
          source: result.toolId,
          data: result.data as unknown as Prisma.InputJsonValue,
        },
      })
      observationSummary = await ingestToolResult(tx, {
        projectId: task.projectId,
        taskId: task.id,
        targetId: task.targetId,
        artifactId: task.artifactId,
        source: result.toolId,
        data: result.data,
      })
    }
    await tx.workspaceActivity.create({
      data: {
        projectId: task.projectId,
        actor: 'Executor',
        eventType: outcome === 'COMPLETED' ? 'analysis.task.completed' : 'analysis.task.failed',
        message: outcome === 'COMPLETED'
          ? `Completed ${task.capability || 'analysis'} for ${task.artifact?.relativePath || 'target'}`
          : `Failed ${task.capability || 'analysis'} for ${task.artifact?.relativePath || 'target'}: ${error}`,
        data: {
          taskId: task.id,
          artifactId: task.artifactId,
          providerId: task.provider?.pluginId || null,
          capability: task.capability,
          ...(outcome === 'COMPLETED' ? { observations: observationSummary } : {}),
          ...(outcome === 'FAILED' ? { error } : {}),
        },
      },
    })
    return updatedTask
  })
  if (!updated) {
    const current = await loadTask(task.projectId, task.id)
    return current ? { outcome: 'SKIPPED', task: serialiseTask(current) } : { outcome: 'SKIPPED', task: serialiseTask(task) }
  }
  return { outcome, task: serialiseTask(updated) }
}

async function failTask(task: TaskRow, runToken: string, message: string): Promise<ExecutedAnalysisTask> {
  return settleTask(task, runToken, 'FAILED', task.provider?.name || 'Provider', undefined, message)
}

export async function executeAnalysisTask(projectId: string, taskId: string, leaseOwner?: string): Promise<ExecutedAnalysisTask | null> {
  const task = await loadTask(projectId, taskId)
  if (!task) return null
  if (task.status !== 'QUEUED') return { outcome: 'SKIPPED', task: serialiseTask(task) }

  const runToken = randomUUID()
  const owner = normaliseLeaseOwner(leaseOwner)
  const claimed = await prisma.task.updateMany({
    where: { id: task.id, projectId, status: 'QUEUED' },
    data: {
      status: 'RUNNING',
      progress: 10,
      startedAt: new Date(),
      leaseHeartbeatAt: new Date(),
      leaseOwner: owner,
      completedAt: null,
      error: '',
      runToken,
    },
  })
  if (claimed.count !== 1) {
    const current = await loadTask(projectId, taskId)
    return current ? { outcome: 'SKIPPED', task: serialiseTask(current) } : null
  }

  if (!task.provider) return failTask(task, runToken, 'Task provider is missing')
  if (!task.provider.enabled) return failTask(task, runToken, 'Task provider is disabled')
  if (!task.artifact) return failTask(task, runToken, 'Task artifact is missing')

  const plugin = getBuiltinProvider(task.provider.pluginId)
  if (!plugin) return failTask(task, runToken, `Provider ${task.provider.pluginId} is not installed`)

  const profile = task.artifact.profile as unknown as TargetProfile
  const match = resolveCapabilities(profile, [plugin])[0]
  const capability = match?.capabilities.find((candidate) => candidate.toLowerCase() === (task.capability || '').toLowerCase())
  if (!match || !capability) return failTask(task, runToken, 'Provider is no longer compatible with the artifact')

  let result: ToolResult
  const controller = new AbortController()
  const stopHeartbeat = startTaskHeartbeat(projectId, task.id, runToken, controller)
  try {
    result = await plugin.analyze({
      targetProfile: profile,
      artifactId: task.artifactId || undefined,
      options: asOptions(task.options),
      signal: controller.signal,
    })
  } catch (error) {
    stopHeartbeat()
    return failTask(task, runToken, error instanceof Error ? error.message : 'Provider execution failed')
  }
  stopHeartbeat()
  if (result.status !== 'completed') return settleTask(task, runToken, 'FAILED', plugin.manifest.name, result, result.error)
  return settleTask(task, runToken, 'COMPLETED', plugin.manifest.name, result)
}

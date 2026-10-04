import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import prisma from '@/lib/prisma'
import { getBuiltinProvider } from './provider-registry'
import { resolveCapabilities } from './capabilities'
import { resolveArtifactStoragePath } from './artifact-storage'
import { ingestToolResult, MAX_CODE_UNITS_PER_RESULT, MAX_OBSERVATIONS_PER_RESULT } from './result-ingestion'
import { boundResultData } from './result-bounds'
import { taskRequiresApproval } from './task-approval'
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
  progressMessage: true,
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
  approval: { select: { status: true } },
  provider: { select: { id: true, pluginId: true, name: true, enabled: true } },
  artifact: { select: { id: true, targetId: true, relativePath: true, profile: true, storagePath: true } },
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
    progressMessage: string
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
    progressMessage: task.progressMessage,
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

function boundedTaskResultData(value: unknown): Prisma.InputJsonValue {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const { observations, ...summary } = value as Record<string, unknown>
    if (Array.isArray(observations)) {
      return boundResultData({ ...summary, normalizedObservationCount: observations.length })
    }
  }
  return boundResultData(value)
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
  const persistedResult = outcome === 'COMPLETED' && result ? boundedTaskResultData(result.data) : undefined
  const completedAt = new Date()
  const transactionOptions = result?.capabilities.some((capability) => capability === 'decompile' || capability === 'disassemble')
    ? { maxWait: 10_000, timeout: 120_000 }
    : undefined
  const updated = await prisma.$transaction(async (tx) => {
    const claim = await tx.task.updateMany({
      where: { id: task.id, projectId: task.projectId, status: 'RUNNING', runToken },
      data: {
        status: outcome,
        progress: outcome === 'COMPLETED' ? 100 : task.progress,
        progressMessage: outcome === 'COMPLETED' ? 'Analysis complete' : 'Analysis failed',
        result: persistedResult,
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
          data: persistedResult as Prisma.InputJsonValue,
        },
      })
      observationSummary = await ingestToolResult(tx, {
        projectId: task.projectId,
        taskId: task.id,
        targetId: task.targetId,
        artifactId: task.artifactId,
        source: result.toolId,
        data: result.data,
        maxObservations: (result.capabilities.includes('decompile') || result.capabilities.includes('disassemble')) ? MAX_CODE_UNITS_PER_RESULT : MAX_OBSERVATIONS_PER_RESULT,
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
  }, transactionOptions)
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
  if (taskRequiresApproval(task.options) && task.approval?.status !== 'APPROVED') {
    return { outcome: 'SKIPPED', task: serialiseTask(task) }
  }

  const runToken = randomUUID()
  const owner = normaliseLeaseOwner(leaseOwner)
  const claimed = await prisma.task.updateMany({
    where: { id: task.id, projectId, status: 'QUEUED' },
    data: {
      status: 'RUNNING',
      progress: 10,
      progressMessage: 'Starting analysis',
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

  let artifactPath: string
  try {
    artifactPath = resolveArtifactStoragePath(task.artifact.storagePath)
  } catch {
    return failTask(task, runToken, 'Artifact storage path is invalid or outside the configured artifact volume')
  }

  let result: ToolResult
  const controller = new AbortController()
  const stopHeartbeat = startTaskHeartbeat(projectId, task.id, runToken, controller)
  const reportProgress = async (message: string) => {
    const progressMessage = message.trim().slice(0, 500)
    if (!progressMessage) return
    try {
      const updated = await prisma.task.updateMany({
        where: { id: task.id, projectId, status: 'RUNNING', runToken },
        data: { progressMessage, leaseHeartbeatAt: new Date() },
      })
      if (updated.count === 0) controller.abort()
    } catch (error) {
      console.warn('Could not persist REAmon analyzer progress:', error)
    }
  }
  try {
    result = await plugin.analyze({
      targetProfile: profile,
      artifactId: task.artifactId || undefined,
      projectId: task.projectId,
      taskId: task.id,
      runToken,
      artifactPath,
      options: asOptions(task.options),
      signal: controller.signal,
      reportProgress,
    })
  } catch (error) {
    stopHeartbeat()
    return failTask(task, runToken, error instanceof Error ? error.message : 'Provider execution failed')
  }
  stopHeartbeat()
  if (result.status !== 'completed') return settleTask(task, runToken, 'FAILED', plugin.manifest.name, result, result.error)
  await reportProgress('Saving analyzer results to the workspace')
  return settleTask(task, runToken, 'COMPLETED', plugin.manifest.name, result)
}

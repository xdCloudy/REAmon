import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { getBuiltinProvider } from './provider-registry'
import { resolveCapabilities } from './capabilities'
import type { TargetProfile, ToolResult } from './types'

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
  startedAt: true,
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

async function loadTask(projectId: string, taskId: string): Promise<TaskRow | null> {
  return prisma.task.findFirst({ where: { id: taskId, projectId }, select: taskSelect })
}

async function settleTask(
  task: TaskRow,
  outcome: 'COMPLETED' | 'FAILED',
  providerName: string,
  result?: ToolResult,
  failure?: string,
): Promise<ExecutedAnalysisTask> {
  const error = boundedError(failure || result?.error || '')
  const completedAt = new Date()
  const updated = await prisma.$transaction(async (tx) => {
    const updatedTask = await tx.task.update({
      where: { id: task.id },
      data: {
        status: outcome,
        progress: outcome === 'COMPLETED' ? 100 : task.progress,
        result: result?.data === undefined ? undefined : result.data as unknown as Prisma.InputJsonValue,
        error: outcome === 'COMPLETED' ? '' : error,
        completedAt,
      },
      select: taskSelect,
    })
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
          ...(outcome === 'FAILED' ? { error } : {}),
        },
      },
    })
    return updatedTask
  })
  return { outcome, task: serialiseTask(updated) }
}

async function failTask(task: TaskRow, message: string): Promise<ExecutedAnalysisTask> {
  return settleTask(task, 'FAILED', task.provider?.name || 'Provider', undefined, message)
}

export async function executeAnalysisTask(projectId: string, taskId: string): Promise<ExecutedAnalysisTask | null> {
  const task = await loadTask(projectId, taskId)
  if (!task) return null
  if (task.status !== 'QUEUED') return { outcome: 'SKIPPED', task: serialiseTask(task) }

  const claimed = await prisma.task.updateMany({
    where: { id: task.id, projectId, status: 'QUEUED' },
    data: { status: 'RUNNING', progress: 10, startedAt: new Date(), error: '' },
  })
  if (claimed.count !== 1) {
    const current = await loadTask(projectId, taskId)
    return current ? { outcome: 'SKIPPED', task: serialiseTask(current) } : null
  }

  if (!task.provider) return failTask(task, 'Task provider is missing')
  if (!task.provider.enabled) return failTask(task, 'Task provider is disabled')
  if (!task.artifact) return failTask(task, 'Task artifact is missing')

  const plugin = getBuiltinProvider(task.provider.pluginId)
  if (!plugin) return failTask(task, `Provider ${task.provider.pluginId} is not installed`)

  const profile = task.artifact.profile as unknown as TargetProfile
  const match = resolveCapabilities(profile, [plugin])[0]
  const capability = match?.capabilities.find((candidate) => candidate.toLowerCase() === (task.capability || '').toLowerCase())
  if (!match || !capability) return failTask(task, 'Provider is no longer compatible with the artifact')

  let result: ToolResult
  try {
    result = await plugin.analyze({
      targetProfile: profile,
      artifactId: task.artifactId || undefined,
      options: asOptions(task.options),
    })
  } catch (error) {
    return failTask(task, error instanceof Error ? error.message : 'Provider execution failed')
  }
  if (result.status !== 'completed') return settleTask(task, 'FAILED', plugin.manifest.name, result, result.error)
  return settleTask(task, 'COMPLETED', plugin.manifest.name, result)
}

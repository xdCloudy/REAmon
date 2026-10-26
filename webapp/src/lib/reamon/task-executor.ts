import { Prisma } from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import prisma from '@/lib/prisma'
import { getBuiltinProvider } from './provider-registry'
import { resolveCapabilities } from './capabilities'
import { resolveArtifactStoragePath } from './artifact-storage'
import { ingestToolResult, MAX_CODE_UNITS_PER_RESULT, MAX_OBSERVATIONS_PER_RESULT } from './result-ingestion'
import { boundResultData } from './result-bounds'
import { taskRequiresApproval } from './task-approval'
import { resolveDerivedArtifactPath } from './derived-storage'
import type { TargetProfile, ToolObservation, ToolResult } from './types'

const DEFAULT_LEASE_OWNER = 'webapp'
const MAX_LEASE_OWNER_LENGTH = 128
const MAX_CODE_ARTIFACT_HASH_FILE_BYTES = 2 * 1024 * 1024
const MAX_CODE_ARTIFACT_HASH_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_CODE_ARTIFACT_HASH_FILES = 1_024

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
  artifact: { select: { id: true, targetId: true, relativePath: true, profile: true, storagePath: true, sha256: true } },
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

function reportedCount(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  }
  return null
}

function providerUnitKind(providerId: string | null): 'function' | 'code-unit' {
  return ['reamon-ghidra', 'reamon-ida', 'reamon-recurse', 'reamon-miasm', 'reamon-wabt', 'reamon-glaurung', 'reamon-kuna', 'reamon-fission', 'reamon-oxidizer', 'reamon-reko', 'reamon-dex-decompiler'].includes(providerId || '')
    ? 'function'
    : 'code-unit'
}

function buildCoverageInventory(data: unknown, providerId: string | null, indexedUnitCount: number): Prisma.InputJsonValue {
  const result = asOptions(data)
  const rawObservations = Array.isArray(result.observations) ? result.observations : []
  const unitKind = providerUnitKind(providerId)
  const observedUnitCount = rawObservations.reduce((count, value) => {
    const observation = asOptions(value)
    if (observation.type !== (unitKind === 'function' ? 'function' : 'code_unit')) return count
    if (providerId === 'reamon-wabt' && asOptions(observation.attributes).language !== 'WebAssembly Text (WAT)') return count
    return count + 1
  }, 0)
  const streamedUnitCount = unitKind === 'function' ? reportedCount(result, ['streamedFunctionObservationCount']) || 0 : 0
  const discoveredUnitCount = reportedCount(result, providerId === 'reamon-wabt'
    ? ['wasmFunctionCount', 'discoveredUnitCount', 'decompiledFunctionCount']
    : ['decompiledCodeUnitCount', 'discoveredCodeUnitCount', 'decompiledClassCount', 'discoveredClassCount', 'classCount', 'discoveredMethodCount', 'decompiledFunctionCount', 'functionCount', 'batchResultCount', 'discoveredUnitCount'])
  const providerReturnedUnitCount = reportedCount(result, ['returnedCodeUnitCount', 'returnedUnitCount', 'returnedClassCount', 'returnedMethodCount', 'returnedFunctionCount'])
    ?? observedUnitCount
  const indexedCoverageUnitCount = Math.min(indexedUnitCount, observedUnitCount, providerReturnedUnitCount)
  const failedUnitCount = reportedCount(result, ['failedFunctionCount', 'failedUnitCount'])
  const visitedUnitCount = reportedCount(result, ['visitedFunctionCount', 'visitedUnitCount'])
  const skippedUnitCount = reportedCount(result, ['skippedCodeUnitCount', 'skippedClassCount', 'skippedFunctionCount', 'skippedUnitCount'])
  const unsupportedUnitCount = reportedCount(result, ['unsupportedCodeUnitCount', 'unsupportedClassCount', 'unsupportedFunctionCount', 'unsupportedUnitCount'])
  const excludedUnitCount = reportedCount(result, ['excludedCodeUnitCount', 'excludedClassCount', 'excludedFunctionCount', 'excludedUnitCount'])
  const omittedUnitCount = reportedCount(result, ['omittedCodeUnitCount', 'omittedClassCount', 'omittedFunctionCount', 'omittedUnitCount'])
  return {
    schemaVersion: 2,
    denominatorSource: discoveredUnitCount === null ? 'unavailable' : 'provider-reported-discovered-units',
    unitKind,
    discoveredUnitCount,
    providerReturnedUnitCount,
    observedUnitCount: observedUnitCount + streamedUnitCount,
    indexedUnitCount: indexedCoverageUnitCount,
    notObservedUnitCount: Math.max(0, providerReturnedUnitCount - observedUnitCount - streamedUnitCount),
    notIndexedUnitCount: Math.max(0, observedUnitCount + streamedUnitCount - indexedCoverageUnitCount),
    unreturnedDiscoveredUnitCount: discoveredUnitCount === null ? null : Math.max(0, discoveredUnitCount - providerReturnedUnitCount),
    failedUnitCount,
    visitedUnitCount,
    notVisitedUnitCount: discoveredUnitCount === null || visitedUnitCount === null
      ? null
      : Math.max(0, discoveredUnitCount - visitedUnitCount),
    skippedUnitCount,
    unsupportedUnitCount,
    excludedUnitCount,
    omittedUnitCount,
    truncated: observedUnitCount > MAX_CODE_UNITS_PER_RESULT
      || (discoveredUnitCount === null
        ? result.truncated === true
        : indexedCoverageUnitCount < discoveredUnitCount),
    coveragePercent: discoveredUnitCount === null
      ? null
      : Math.min(100, Math.round((indexedCoverageUnitCount / Math.max(1, discoveredUnitCount)) * 100)),
  }
}

function persistedResultWithCoverage(value: Prisma.InputJsonValue | undefined, inventory: Prisma.InputJsonValue): Prisma.InputJsonValue {
  const record = asOptions(value)
  return { ...record, coverageInventory: inventory } as Prisma.InputJsonObject
}

function boundedError(value: string): string {
  return value.trim().slice(0, 4000) || 'Provider execution failed'
}

function pendingObservationSource(toolId: string, runToken: string): string {
  return `${toolId}:pending:${runToken}`
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

function isInsideDirectory(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function attachCodeArtifactProvenance(task: TaskRow, runToken: string, result: ToolResult): Promise<ToolResult> {
  if (result.toolId === 'reamon-tocode-import'
    || !result.capabilities.some((capability) => capability === 'decompile' || capability === 'disassemble')
    || !task.artifact || !task.artifactId || !/^[a-f0-9]{64}$/i.test(task.artifact.sha256)) return result
  const observations = result.data.observations
  if (!Array.isArray(observations) || observations.length === 0) return result

  const projectId = task.projectId
  const runPrefix = `${projectId}/${task.artifactId}/${task.id}/${runToken}`
  let runRoot: string
  try {
    runRoot = await realpath(resolveDerivedArtifactPath(runPrefix))
  } catch {
    return result
  }

  const inputArtifactSha256 = task.artifact.sha256.toLowerCase()
  const sourceHashByPath = new Map<string, string | null>()
  let sourceFilesHashed = 0
  let sourceBytesHashed = 0
  let changed = false
  const enrichedObservations: unknown[] = []
  for (const observationValue of observations) {
    if (!observationValue || typeof observationValue !== 'object' || Array.isArray(observationValue)) {
      enrichedObservations.push(observationValue)
      continue
    }
    const observation = observationValue as Record<string, unknown>
    const attributes = observation.attributes && typeof observation.attributes === 'object' && !Array.isArray(observation.attributes)
      ? observation.attributes as Record<string, unknown>
      : null
    const codeArtifactId = attributes?.codeArtifactId
    if (observation.type !== 'code_unit' || !attributes || typeof codeArtifactId !== 'string'
      || !codeArtifactId.startsWith(`${runPrefix}/`)) {
      enrichedObservations.push(observationValue)
      continue
    }
    const relativeFile = codeArtifactId.slice(runPrefix.length + 1)
    const segments = relativeFile.split('/')
    if (!relativeFile || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
      enrichedObservations.push(observationValue)
      continue
    }
    const reportedInputHash = attributes.inputArtifactSha256
    if (reportedInputHash !== undefined
      && (typeof reportedInputHash !== 'string' || reportedInputHash.toLowerCase() !== inputArtifactSha256)) {
      enrichedObservations.push(observationValue)
      continue
    }

    let sourceHash = sourceHashByPath.get(codeArtifactId)
    if (!sourceHashByPath.has(codeArtifactId)) {
      sourceHashByPath.set(codeArtifactId, null)
      if (sourceFilesHashed >= MAX_CODE_ARTIFACT_HASH_FILES) {
        enrichedObservations.push({ ...observation, attributes: { ...attributes, inputArtifactSha256 } })
        changed = true
        continue
      }
      try {
        const candidatePath = resolveDerivedArtifactPath(codeArtifactId)
        const candidateRealPath = await realpath(candidatePath)
        if (!isInsideDirectory(runRoot, candidateRealPath)) throw new Error('Code artifact is outside its task run')
        const info = await stat(candidateRealPath)
        if (!info.isFile() || info.size <= 0 || info.size > MAX_CODE_ARTIFACT_HASH_FILE_BYTES
          || sourceBytesHashed + info.size > MAX_CODE_ARTIFACT_HASH_TOTAL_BYTES) throw new Error('Code artifact exceeds hash limits')
        const bytes = await readFile(candidateRealPath)
        sourceHash = createHash('sha256').update(bytes).digest('hex')
        sourceHashByPath.set(codeArtifactId, sourceHash)
        sourceFilesHashed += 1
        sourceBytesHashed += bytes.byteLength
      } catch {
        sourceHashByPath.set(codeArtifactId, null)
      }
    }
    const enrichedAttributes = {
      ...attributes,
      inputArtifactSha256,
      ...(sourceHash ? { codeArtifactSha256: sourceHash } : {}),
    }
    enrichedObservations.push({ ...observation, attributes: enrichedAttributes })
    changed = true
  }
  return changed ? { ...result, data: { ...result.data, observations: enrichedObservations } } : result
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
      }).then((updated) => {
        if (updated.count !== 1) controller.abort()
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
  streamedObservationCount = 0,
): Promise<ExecutedAnalysisTask> {
  const error = boundedError(failure || result?.error || '')
  let persistedResult = outcome === 'COMPLETED' && result ? boundedTaskResultData(result.data) : undefined
  const completedAt = new Date()
  const transactionOptions = result?.capabilities.some((capability) => capability === 'decompile' || capability === 'disassemble' || capability === 'recover_metadata')
    ? { maxWait: 10_000, timeout: 120_000 }
    : undefined
  const updated = await prisma.$transaction(async (tx) => {
    const lastProgress = outcome === 'FAILED'
      ? await tx.task.findFirst({
        where: { id: task.id, projectId: task.projectId, status: 'RUNNING', runToken },
        select: { progressMessage: true },
      })
      : null
    const claim = await tx.task.updateMany({
      where: { id: task.id, projectId: task.projectId, status: 'RUNNING', runToken },
      data: {
        status: outcome,
        progress: outcome === 'COMPLETED' ? 100 : task.progress,
        progressMessage: outcome === 'COMPLETED' ? 'Analysis complete' : lastProgress?.progressMessage || 'Analysis failed',
        result: persistedResult,
        error: outcome === 'COMPLETED' ? '' : error,
        leaseHeartbeatAt: null,
        leaseOwner: null,
        completedAt,
      },
    })
    if (claim.count !== 1) return null

    let observationSummary = { accepted: 0, rejected: 0 }
    if (outcome === 'COMPLETED' && result) {
      observationSummary = await ingestToolResult(tx, {
        projectId: task.projectId,
        taskId: task.id,
        targetId: task.targetId,
        artifactId: task.artifactId,
        source: result.toolId,
        data: result.data,
        maxObservations: (result.capabilities.includes('decompile') || result.capabilities.includes('disassemble') || result.capabilities.includes('recover_metadata'))
          ? MAX_CODE_UNITS_PER_RESULT
          : MAX_OBSERVATIONS_PER_RESULT,
      })
      observationSummary.accepted += streamedObservationCount
      if (result.toolId === 'reamon-dex-decompiler' && streamedObservationCount > 0) {
        const pendingSource = pendingObservationSource(result.toolId, runToken)
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "reamon_observations" (
            "id", "project_id", "task_id", "target_id", "artifact_id", "kind", "type",
            "stable_key", "canonical_key", "label", "source", "relation", "from_key", "to_key",
            "from_canonical_key", "to_canonical_key", "attributes", "is_pending", "created_at", "updated_at"
          )
          SELECT
            'c' || md5(pending."id" || ${runToken}), pending."project_id", pending."task_id", pending."target_id",
            pending."artifact_id", pending."kind", pending."type", pending."stable_key", pending."canonical_key",
            pending."label", ${result.toolId}, pending."relation", pending."from_key", pending."to_key",
            pending."from_canonical_key", pending."to_canonical_key", pending."attributes" - 'analysisPending', FALSE,
            pending."created_at", CURRENT_TIMESTAMP
          FROM "reamon_observations" AS pending
          WHERE pending."project_id" = ${task.projectId}
            AND pending."task_id" = ${task.id}
            AND pending."source" = ${pendingSource}
            AND pending."type" = 'function'
          ON CONFLICT ("project_id", "source", "stable_key") DO UPDATE SET
            "task_id" = EXCLUDED."task_id",
            "target_id" = EXCLUDED."target_id",
            "artifact_id" = EXCLUDED."artifact_id",
            "kind" = EXCLUDED."kind",
            "type" = EXCLUDED."type",
            "canonical_key" = EXCLUDED."canonical_key",
            "label" = EXCLUDED."label",
            "relation" = EXCLUDED."relation",
            "from_key" = EXCLUDED."from_key",
            "to_key" = EXCLUDED."to_key",
            "from_canonical_key" = EXCLUDED."from_canonical_key",
            "to_canonical_key" = EXCLUDED."to_canonical_key",
            "attributes" = EXCLUDED."attributes",
            "is_pending" = FALSE,
            "updated_at" = CURRENT_TIMESTAMP
        `)
        await tx.reamonObservation.deleteMany({
          where: { projectId: task.projectId, taskId: task.id, source: pendingSource, type: 'function' },
        })
      }
      if (persistedResult && (result.capabilities.includes('decompile') || result.capabilities.includes('disassemble'))) {
        const indexedType = providerUnitKind(task.provider?.pluginId || null) === 'function' ? 'function' : 'code_unit'
        const indexedUnitCount = await tx.reamonObservation.count({
          where: { projectId: task.projectId, taskId: task.id, type: indexedType },
        })
        persistedResult = persistedResultWithCoverage(persistedResult, buildCoverageInventory(result.data, task.provider?.pluginId || null, indexedUnitCount))
        await tx.task.update({ where: { id: task.id }, data: { result: persistedResult } })
      }
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
    return tx.task.findUnique({ where: { id: task.id }, select: taskSelect })
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
      progress: 0,
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
  let streamedObservationCount = 0
  let streamedObservationSourceReady = false
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
  const pendingSource = pendingObservationSource(plugin.manifest.id, runToken)
  const persistObservationBatch = async (batch: ToolObservation[]): Promise<number> => {
    if (!batch.length) return 0
    if (controller.signal.aborted) throw new Error('Analysis was cancelled before observations could be saved')
    const summary = await prisma.$transaction(async (tx) => {
      const ownsLease = await tx.task.findFirst({
        where: { id: task.id, projectId: task.projectId, status: 'RUNNING', runToken },
        select: { id: true },
      })
      if (!ownsLease) throw new Error('Analysis task no longer owns its execution lease')
      if (!streamedObservationSourceReady) {
        await tx.reamonObservation.deleteMany({
          where: {
            projectId: task.projectId,
            taskId: task.id,
            source: { startsWith: `${plugin.manifest.id}:pending:` },
            type: 'function',
          },
        })
        streamedObservationSourceReady = true
      }
      return ingestToolResult(tx, {
        projectId: task.projectId,
        taskId: task.id,
        targetId: task.targetId,
        artifactId: task.artifactId,
        source: pendingSource,
        data: { observations: batch },
        maxObservations: batch.length,
        isPending: true,
      })
    })
    streamedObservationCount += summary.accepted
    return summary.accepted
  }
  const discardStreamedObservations = async () => {
    if (!streamedObservationSourceReady) return
    const activeRun = await prisma.task.findFirst({
      where: { id: task.id, projectId: task.projectId, status: { in: ['RUNNING', 'CANCELLED', 'FAILED'] }, runToken },
      select: { id: true },
    }).catch(() => null)
    if (!activeRun) return
    await prisma.reamonObservation.deleteMany({
      where: { projectId: task.projectId, taskId: task.id, source: pendingSource, type: 'function' },
    }).catch((error) => console.warn('Could not discard incomplete streamed DEX observations:', error))
  }
  try {
    result = await plugin.analyze({
      targetProfile: profile,
      artifactId: task.artifactId || undefined,
      projectId: task.projectId,
      taskId: task.id,
      runToken,
      artifactPath,
      artifactRelativePath: task.artifact.relativePath,
      options: asOptions(task.options),
      signal: controller.signal,
      reportProgress,
      persistObservationBatch,
    })
  } catch (error) {
    stopHeartbeat()
    await discardStreamedObservations()
    return failTask(task, runToken, error instanceof Error ? error.message : 'Provider execution failed')
  }
  if (result.status !== 'completed') {
    stopHeartbeat()
    await discardStreamedObservations()
    return settleTask(task, runToken, 'FAILED', plugin.manifest.name, result, result.error)
  }
  try {
    result = await attachCodeArtifactProvenance(task, runToken, result)
  } catch (error) {
    stopHeartbeat()
    await discardStreamedObservations()
    return failTask(task, runToken, error instanceof Error ? error.message : 'Could not attach analysis provenance')
  }
  stopHeartbeat()
  await reportProgress('Saving analyzer results to the workspace')
  try {
    return await settleTask(task, runToken, 'COMPLETED', plugin.manifest.name, result, undefined, streamedObservationCount)
  } catch (error) {
    await discardStreamedObservations()
    return failTask(task, runToken, error instanceof Error ? error.message : 'Could not save analyzer results')
  }
}

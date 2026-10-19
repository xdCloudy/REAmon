import { createHash, randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { AgentUnreachableError, agentFetch } from '@/lib/agentFetch'

const MAX_BATCH_SIZE = 5
const MAX_DEPENDENCY_CANDIDATES = 100
const MAX_DEPENDENCY_EDGES = 20_000
const MAX_CALLEE_EDGE_SCAN = 100_000
const CALLEE_EDGE_PAGE_SIZE = 512
const MAX_RESULT_BYTES = 128 * 1024
const MAX_REWRITE_HISTORY_BYTES = MAX_RESULT_BYTES * 2 + 8 * 1024
const REWRITE_LEASE_GRACE_MS = 60_000
const MAX_REWRITE_TIMEOUT_MS = 5 * 60_000
const STALE_JOB_GRACE_MS = 60_000
const LEASE_HEARTBEAT_INTERVAL_MS = 15_000

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function validatedRewriteHistory(value: unknown): Prisma.InputJsonArray | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) return undefined
  const entries: Prisma.InputJsonObject[] = []
  let totalBytes = 0
  for (const item of value) {
    const round = record(item)
    const sourceCode = round.source_code
    const sourceSha256 = round.source_sha256
    const validationStatus = round.validation_status
    const validationMethod = round.validation_method
    const validationMessage = round.validation_message
    if (typeof round.round !== 'number' || !Number.isSafeInteger(round.round) || (round.round !== 1 && round.round !== 2)
      || typeof sourceCode !== 'string' || !sourceCode
      || typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sourceSha256)
      || typeof validationStatus !== 'string'
      || (validationStatus !== 'PASSED' && validationStatus !== 'FAILED' && validationStatus !== 'UNAVAILABLE')
      || typeof validationMethod !== 'string' || validationMethod.length > 80
      || typeof validationMessage !== 'string' || validationMessage.length > 2000) return undefined
    const sourceBytes = Buffer.byteLength(sourceCode, 'utf8')
    totalBytes += sourceBytes
    if (sourceBytes > MAX_RESULT_BYTES || totalBytes > MAX_REWRITE_HISTORY_BYTES
      || createHash('sha256').update(sourceCode, 'utf8').digest('hex') !== sourceSha256.toLowerCase()) return undefined
    entries.push({
      round: round.round,
      sourceCode,
      sourceSha256: sourceSha256.toLowerCase(),
      validationStatus,
      validationMethod,
      validationMessage,
    })
  }
  return entries
}

function dependencyGroup(row: { projectId: string; artifactId: string; taskId: string | null; source: string }): string {
  return JSON.stringify([row.projectId, row.artifactId, row.taskId, row.source])
}

async function hasPendingCalleeAttempt(input: {
  id: string
  projectId: string
  artifactId: string
  codeUnitId: string
  scope: string
}): Promise<boolean> {
  if (input.scope === 'member') return false
  const unit = await prisma.reamonObservation.findFirst({
    where: { id: input.codeUnitId, projectId: input.projectId, artifactId: input.artifactId, kind: 'entity', type: 'code_unit' },
    select: { taskId: true, source: true, stableKey: true },
  })
  if (!unit?.taskId || !unit.stableKey) return false

  let scanned = 0
  let cursor: string | undefined
  while (scanned < MAX_CALLEE_EDGE_SCAN) {
    const pageLimit = Math.min(CALLEE_EDGE_PAGE_SIZE, MAX_CALLEE_EDGE_SCAN - scanned)
    const edges = await prisma.reamonObservation.findMany({
      where: {
        projectId: input.projectId,
        artifactId: input.artifactId,
        taskId: unit.taskId,
        source: unit.source,
        kind: 'relationship',
        type: 'calls',
        OR: [
          { fromKey: unit.stableKey },
          { attributes: { path: ['fromCodeUnitKey'], equals: unit.stableKey } },
        ],
      },
      select: { id: true, fromKey: true, toKey: true, attributes: true },
      orderBy: { id: 'asc' },
      take: pageLimit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (!edges.length) return false
    scanned += edges.length
    const calleeKeys = new Set<string>()
    for (const edge of edges) {
      const attributes = record(edge.attributes)
      const isUnitEdge = edge.fromKey === unit.stableKey
      const targetKey = isUnitEdge
        ? edge.toKey
        : typeof attributes.toCodeUnitKey === 'string' ? attributes.toCodeUnitKey : edge.toKey
      if (targetKey && targetKey !== unit.stableKey) calleeKeys.add(targetKey)
    }
    if (calleeKeys.size) {
      const callees = await prisma.reamonObservation.findMany({
        where: {
          projectId: input.projectId,
          artifactId: input.artifactId,
          taskId: unit.taskId,
          source: unit.source,
          kind: 'entity',
          type: 'code_unit',
          stableKey: { in: [...calleeKeys] },
        },
        select: { id: true },
      })
      const calleeIds = callees.map((callee) => callee.id).filter((id) => id !== input.codeUnitId)
      if (calleeIds.length && await prisma.reamonCodeAttempt.findFirst({
        where: {
          projectId: input.projectId,
          artifactId: input.artifactId,
          codeUnitId: { in: calleeIds },
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        select: { id: true },
      })) return true
    }
    cursor = edges[edges.length - 1].id
    if (edges.length < pageLimit) return false
  }

  // A pathological unit exceeded the bounded scan, so readiness cannot be proven.
  return true
}

async function orderQueuedAttempts<T extends {
  id: string
  projectId: string
  artifactId: string
  codeUnitId: string
  scope: string
  createdAt: Date
}>(queued: T[]): Promise<{ ordered: T[]; blockedAttemptIds: Set<string>; complete: boolean }> {
  const unchanged = { ordered: queued, blockedAttemptIds: new Set<string>(), complete: true }
  if (!queued.length) return unchanged
  if (queued.length > MAX_DEPENDENCY_CANDIDATES) return { ...unchanged, complete: false }
  const wholeUnit = queued.filter((attempt) => attempt.scope !== 'member')
  if (!wholeUnit.length) return unchanged
  const observations = await prisma.reamonObservation.findMany({
    where: { id: { in: [...new Set(queued.map((attempt) => attempt.codeUnitId))] }, type: 'code_unit' },
    select: { id: true, projectId: true, artifactId: true, taskId: true, stableKey: true, source: true },
  })
  const observationById = new Map(observations.map((observation) => [observation.id, observation]))
  const groups = new Map<string, { projectId: string; artifactId: string; taskId: string; source: string }>()
  const attemptIdsByGroupAndKey = new Map<string, string[]>()
  const stableKeysByGroup = new Map<string, Set<string>>()
  for (const attempt of wholeUnit) {
    const observation = observationById.get(attempt.codeUnitId)
    if (!observation?.taskId || observation.artifactId !== attempt.artifactId || observation.projectId !== attempt.projectId) continue
    const group = dependencyGroup({ projectId: observation.projectId, artifactId: attempt.artifactId, taskId: observation.taskId, source: observation.source })
    groups.set(group, {
      projectId: observation.projectId,
      artifactId: observation.artifactId || attempt.artifactId,
      taskId: observation.taskId,
      source: observation.source,
    })
    const stableKeys = stableKeysByGroup.get(group) || new Set<string>()
    stableKeys.add(observation.stableKey)
    stableKeysByGroup.set(group, stableKeys)
  }
  for (const attempt of queued) {
    const observation = observationById.get(attempt.codeUnitId)
    if (!observation?.taskId || observation.artifactId !== attempt.artifactId || observation.projectId !== attempt.projectId) continue
    const group = dependencyGroup({ projectId: observation.projectId, artifactId: attempt.artifactId, taskId: observation.taskId, source: observation.source })
    const key = `${group}\u0000${observation.stableKey}`
    const ids = attemptIdsByGroupAndKey.get(key) || []
    ids.push(attempt.id)
    attemptIdsByGroupAndKey.set(key, ids)
    const stableKeys = stableKeysByGroup.get(group) || new Set<string>()
    stableKeys.add(observation.stableKey)
    stableKeysByGroup.set(group, stableKeys)
  }
  if (!groups.size) return unchanged

  const edges = await prisma.reamonObservation.findMany({
    where: {
      kind: 'relationship',
      type: 'calls',
      OR: [...groups.entries()].map(([group, identity]) => {
        const stableKeys = [...(stableKeysByGroup.get(group) || [])]
        return {
          ...identity,
          OR: [
            { fromKey: { in: stableKeys } },
            { toKey: { in: stableKeys } },
            ...stableKeys.flatMap((key) => [
              { attributes: { path: ['fromCodeUnitKey'], equals: key } },
              { attributes: { path: ['toCodeUnitKey'], equals: key } },
            ]),
          ],
        }
      }),
    },
    select: { projectId: true, artifactId: true, taskId: true, source: true, fromKey: true, toKey: true, attributes: true },
    orderBy: { stableKey: 'asc' },
    take: MAX_DEPENDENCY_EDGES + 1,
  })
  // An incomplete graph cannot safely establish that a caller is ready.
  if (edges.length > MAX_DEPENDENCY_EDGES) return { ...unchanged, complete: false }

  const dependencies = new Map(queued.map((attempt) => [attempt.id, new Set<string>()]))
  const outgoing: Array<{ group: string; callerIds: string[]; calleeKeys: string[] }> = []
  const extraCalleeKeysByGroup = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (!edge.taskId || !edge.artifactId) continue
    const group = dependencyGroup({ ...edge, taskId: edge.taskId, artifactId: edge.artifactId })
    const attributes = record(edge.attributes)
    const fromKeys = new Set([edge.fromKey, attributes.fromCodeUnitKey].filter((key): key is string => typeof key === 'string'))
    const toKeys = new Set([edge.toKey, attributes.toCodeUnitKey].filter((key): key is string => typeof key === 'string'))
    const callerIds = [...new Set([...fromKeys].flatMap((key) => attemptIdsByGroupAndKey.get(`${group}\u0000${key}`) || []))]
      .filter((id) => queued.find((attempt) => attempt.id === id)?.scope !== 'member')
    if (!callerIds.length) continue
    const calleeKeys = [...toKeys]
    const extraKeys = extraCalleeKeysByGroup.get(group) || new Set<string>()
    for (const key of calleeKeys) extraKeys.add(key)
    extraCalleeKeysByGroup.set(group, extraKeys)
    outgoing.push({ group, callerIds, calleeKeys })
  }

  const calleeObservationConditions = [...extraCalleeKeysByGroup.entries()].map(([group, stableKeys]) => ({
    ...(groups.get(group) || {}),
    stableKey: { in: [...stableKeys] },
    kind: 'entity',
    type: 'code_unit',
  }))
  const additionalCallees = calleeObservationConditions.length ? await prisma.reamonObservation.findMany({
    where: { OR: calleeObservationConditions },
    select: { id: true, projectId: true, artifactId: true, taskId: true, stableKey: true, source: true },
    take: MAX_DEPENDENCY_CANDIDATES * 20 + 1,
  }) : []
  if (additionalCallees.length > MAX_DEPENDENCY_CANDIDATES * 20) return { ...unchanged, complete: false }
  const calleeObservationByGroupAndKey = new Map<string, string>()
  for (const observation of [...observations, ...additionalCallees]) {
    if (!observation.taskId || !observation.artifactId) continue
    const group = dependencyGroup({ ...observation, taskId: observation.taskId, artifactId: observation.artifactId })
    calleeObservationByGroupAndKey.set(`${group}\u0000${observation.stableKey}`, observation.id)
  }
  const calleeUnitIds = [...new Set(outgoing.flatMap(({ group, calleeKeys }) => calleeKeys.flatMap((key) => {
    const id = calleeObservationByGroupAndKey.get(`${group}\u0000${key}`)
    return id ? [id] : []
  })))]
  const pendingCalleeAttempts = calleeUnitIds.length ? await prisma.reamonCodeAttempt.findMany({
    where: { codeUnitId: { in: calleeUnitIds }, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true, codeUnitId: true, status: true },
  }) : []
  const attemptById = new Map(queued.map((attempt) => [attempt.id, attempt]))
  const pendingByUnitId = new Map<string, typeof pendingCalleeAttempts>()
  for (const pending of pendingCalleeAttempts) {
    const rows = pendingByUnitId.get(pending.codeUnitId) || []
    rows.push(pending)
    pendingByUnitId.set(pending.codeUnitId, rows)
  }
  const blockedAttemptIds = new Set<string>()
  for (const { group, callerIds, calleeKeys } of outgoing) {
    for (const key of calleeKeys) {
      const calleeId = calleeObservationByGroupAndKey.get(`${group}\u0000${key}`)
      if (!calleeId) continue
      const pending = pendingByUnitId.get(calleeId) || []
      for (const callee of pending) {
        const queuedCallee = attemptById.get(callee.id)
        for (const callerId of callerIds) {
          if (callerId === callee.id) continue
          if (queuedCallee && queuedCallee.scope !== 'member') dependencies.get(callerId)?.add(callee.id)
          else blockedAttemptIds.add(callerId)
        }
      }
    }
  }
  let propagatedBlock = true
  while (propagatedBlock) {
    propagatedBlock = false
    for (const [attemptId, dependencyIds] of dependencies) {
      if (!blockedAttemptIds.has(attemptId) && [...dependencyIds].some((dependencyId) => blockedAttemptIds.has(dependencyId))) {
        blockedAttemptIds.add(attemptId)
        propagatedBlock = true
      }
    }
  }

  const remaining = new Set(queued.map((attempt) => attempt.id))
  const byId = attemptById
  const ordered: T[] = []
  while (remaining.size) {
    const ready = [...remaining]
      .filter((attemptId) => [...(dependencies.get(attemptId) || [])].every((dependencyId) => !remaining.has(dependencyId)))
      .map((attemptId) => byId.get(attemptId)!)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    if (!ready.length) {
      // Recursive call cycles have no leaf. Keep their original FIFO order.
      ordered.push(...queued.filter((attempt) => remaining.has(attempt.id)))
      break
    }
    for (const attempt of ready) {
      ordered.push(attempt)
      remaining.delete(attempt.id)
    }
  }
  return { ordered, blockedAttemptIds, complete: true }
}

function messageForCode(code: string): string {
  if (code === 'providers_unreachable') return 'Could not load your saved AI provider. Try again shortly.'
  if (code === 'model_unavailable') return 'The selected AI provider could not answer. Check its settings and try again.'
  if (code === 'incomplete_source') return 'The model stopped before returning the complete file. Increase its output token limit or choose a model with a larger context window, then retry.'
  if (code === 'invalid_source') return 'The model draft did not parse as complete source. Try a stronger model or a more focused transformation.'
  if (code === 'declaration_changed') return 'This rewrite changed declarations or the function interface, including access or type information, so it was rejected and no new draft was saved. Review any earlier draft separately, then retry with a stronger model.'
  if (code === 'declaration_removed') return 'This rewrite removed one or more functions or methods from the selected source, so it was rejected and no new draft was saved. Retry with a narrower request and preserve every callable.'
  if (code === 'signature_changed') return 'This rewrite changed the selected function or method signature, so it was rejected and no new draft was saved. Retry with a focused request and preserve its declaration.'
  if (code === 'behavior_dropped') return 'The model removed executable Java logic. Choose a stronger model or retry with a narrower transformation.'
  if (code === 'wrong_target') return 'The model still returned a different Java type after retrying with the selected file only. Choose a stronger model.'
  if (code === 'context_exceeded') return 'This code unit exceeds the model context window even after related-code context was removed. Choose a larger-context model or a smaller code unit.'
  return 'AI could not produce a maintainable version. Try again shortly.'
}

async function settleFailure(input: {
  attemptId: string
  runToken: string
  code: string
  message: string
  status?: string
  method?: string | null
  validationMessage?: string | null
  rewriteHistory?: Prisma.InputJsonArray
}) {
  const failed = await prisma.reamonCodeAttempt.updateMany({
    where: { id: input.attemptId, status: 'RUNNING', runToken: input.runToken, cancelRequested: false },
    data: {
      status: 'FAILED',
      errorCode: input.code.slice(0, 128),
      errorMessage: input.message,
      validationStatus: input.status?.slice(0, 32) ?? null,
      validationMethod: input.method?.slice(0, 80) ?? null,
      validationMessage: input.validationMessage?.slice(0, 2000) ?? null,
      ...(input.rewriteHistory ? { rewriteHistory: input.rewriteHistory } : {}),
      completedAt: new Date(),
      runToken: null,
      leaseOwner: null,
      leaseHeartbeatAt: null,
    },
  })
  if (failed.count === 0) {
    await prisma.reamonCodeAttempt.updateMany({
      where: { id: input.attemptId, status: 'RUNNING', runToken: input.runToken, cancelRequested: true },
      data: {
        status: 'CANCELLED',
        errorCode: 'cancelled',
        errorMessage: 'The rewrite was cancelled by the operator.',
        completedAt: new Date(),
        runToken: null,
        leaseOwner: null,
        leaseHeartbeatAt: null,
      },
    })
  }
}

async function settleCancelled(attemptId: string, runToken: string) {
  return prisma.reamonCodeAttempt.updateMany({
    where: { id: attemptId, status: 'RUNNING', runToken, cancelRequested: true },
    data: {
      status: 'CANCELLED',
      errorCode: 'cancelled',
      errorMessage: 'The rewrite was cancelled by the operator.',
      completedAt: new Date(),
      runToken: null,
      leaseOwner: null,
      leaseHeartbeatAt: null,
    },
  })
}

async function executeAttempt(attemptId: string, workerId: string) {
  const attempt = await prisma.reamonCodeAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, projectId: true, artifactId: true, codeUnitId: true, scope: true, status: true, requestPayload: true, timeoutMs: true, unitLeaseId: true },
  })
  if (!attempt || attempt.status !== 'QUEUED') return false
  if (await hasPendingCalleeAttempt(attempt)) return false

  const now = new Date()
  const timeoutMs = Math.max(10_000, Math.min(MAX_REWRITE_TIMEOUT_MS, attempt.timeoutMs))
  const runToken = randomUUID()
  const claim = await prisma.$transaction(async (tx) => {
    const updated = await tx.reamonCodeAttempt.updateMany({
      where: { id: attempt.id, projectId: attempt.projectId, status: 'QUEUED', cancelRequested: false },
      data: { status: 'RUNNING', runToken, leaseOwner: workerId, leaseHeartbeatAt: now },
    })
    if (updated.count !== 1) return 'lost' as const

    const lease = attempt.unitLeaseId
      ? await tx.reamonCodeUnitLease.updateMany({
        where: { id: attempt.unitLeaseId, projectId: attempt.projectId, expiresAt: { gt: now } },
        data: { expiresAt: new Date(now.getTime() + timeoutMs + REWRITE_LEASE_GRACE_MS) },
      })
      : { count: 0 }
    if (lease.count !== 1) {
      await tx.reamonCodeAttempt.updateMany({
        where: { id: attempt.id, status: 'RUNNING', runToken },
        data: {
          status: 'FAILED', errorCode: 'lease_lost',
          errorMessage: 'The rewrite request expired before a worker could start it. Retry to start a new attempt.',
          completedAt: new Date(), runToken: null, leaseOwner: null, leaseHeartbeatAt: null,
        },
      })
      if (attempt.unitLeaseId) await tx.reamonCodeUnitLease.deleteMany({ where: { id: attempt.unitLeaseId, expiresAt: { lte: now } } })
      return 'lease_lost' as const
    }
    return 'claimed' as const
  })
  if (claim !== 'claimed') return false

  const controller = new AbortController()
  let abortReason: 'cancelled' | 'lease_lost' | 'heartbeat_error' | 'timeout' | null = null
  let heartbeatRunning = false
  const renewLease = async () => {
    if (heartbeatRunning || abortReason) return
    heartbeatRunning = true
    try {
      const now = new Date()
      const outcome = await prisma.$transaction(async (tx) => {
        const heartbeat = await tx.reamonCodeAttempt.updateMany({
          where: { id: attempt.id, status: 'RUNNING', runToken, cancelRequested: false },
          data: { leaseHeartbeatAt: now },
        })
        if (heartbeat.count !== 1) {
          const current = await tx.reamonCodeAttempt.findUnique({ where: { id: attempt.id }, select: { cancelRequested: true } })
          return current?.cancelRequested ? 'cancelled' as const : 'lease_lost' as const
        }
        const lease = attempt.unitLeaseId
          ? await tx.reamonCodeUnitLease.updateMany({
            where: { id: attempt.unitLeaseId, projectId: attempt.projectId, expiresAt: { gt: now } },
            data: { expiresAt: new Date(now.getTime() + timeoutMs + REWRITE_LEASE_GRACE_MS) },
          })
          : { count: 0 }
        return lease.count === 1 ? null : 'lease_lost' as const
      })
      if (outcome) {
        abortReason = outcome
        controller.abort()
      }
    } catch {
      abortReason = 'heartbeat_error'
      controller.abort()
    } finally {
      heartbeatRunning = false
    }
  }
  const heartbeatTimer = setInterval(() => { void renewLease() }, LEASE_HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()
  const timeoutTimer = setTimeout(() => {
    if (!controller.signal.aborted) {
      abortReason = 'timeout'
      controller.abort()
    }
  }, timeoutMs)
  timeoutTimer.unref?.()

  try {
    const payload = record(attempt.requestPayload)
    if (!Object.keys(payload).length) {
      await settleFailure({ attemptId: attempt.id, runToken, code: 'missing_request', message: 'The saved rewrite request is incomplete. Retry to create a new attempt.' })
      return true
    }

    const response = await agentFetch('/reamon/code/deobfuscate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }, { timeoutMs })
    const result = record(await response.json().catch(() => null))
    const rewriteHistory = validatedRewriteHistory(result.rewrite_history)
    if (!response.ok) {
      const code = typeof result.code === 'string' ? result.code : `http_${response.status}`
      await settleFailure({
        attemptId: attempt.id,
        runToken,
        code,
        message: messageForCode(code),
        status: typeof result.validation_status === 'string' ? result.validation_status : code === 'invalid_source' ? 'FAILED' : undefined,
        method: typeof result.validation_method === 'string' ? result.validation_method : null,
        validationMessage: typeof result.validation_message === 'string' ? result.validation_message : null,
        rewriteHistory,
      })
      return true
    }

    if (typeof result.source_code !== 'string' || !result.source_code.trim()) {
      await settleFailure({ attemptId: attempt.id, runToken, code: 'empty_result', message: 'The AI provider returned no rewritten source' })
      return true
    }
    if (Buffer.byteLength(result.source_code, 'utf8') > MAX_RESULT_BYTES) {
      await settleFailure({ attemptId: attempt.id, runToken, code: 'result_too_large', message: 'The rewritten source exceeds the save limit' })
      return true
    }
    const rewrittenSource = result.source_code

    const validationStatus = ['PASSED', 'FAILED', 'UNAVAILABLE'].includes(String(result.validation_status))
      ? String(result.validation_status)
      : result.syntax_validated === true ? 'PASSED' : 'UNAVAILABLE'
    const finalizedAt = new Date()
    const finalized = await prisma.$transaction(async (tx) => {
      const lease = attempt.unitLeaseId
        ? await tx.reamonCodeUnitLease.updateMany({
          where: { id: attempt.unitLeaseId, projectId: attempt.projectId, expiresAt: { gt: finalizedAt } },
          data: { expiresAt: new Date(finalizedAt.getTime() + REWRITE_LEASE_GRACE_MS) },
        })
        : { count: 0 }
      if (lease.count !== 1) return false
      const updated = await tx.reamonCodeAttempt.updateMany({
        where: { id: attempt.id, projectId: attempt.projectId, status: 'RUNNING', runToken, cancelRequested: false },
        data: {
          status: 'SUCCEEDED', resultSource: rewrittenSource,
          ...(rewriteHistory ? { rewriteHistory } : {}),
          syntaxValidated: result.syntax_validated === true,
          validationStatus,
          validationMethod: typeof result.validation_method === 'string' ? result.validation_method.slice(0, 80) : null,
          validationMessage: typeof result.validation_message === 'string' ? result.validation_message.slice(0, 2000) : null,
          completedAt: finalizedAt,
          runToken: null,
          leaseOwner: null,
          leaseHeartbeatAt: null,
        },
      })
      return updated.count === 1
    })
    if (!finalized) {
      const current = await prisma.reamonCodeAttempt.findUnique({ where: { id: attempt.id }, select: { cancelRequested: true } })
      if (current?.cancelRequested) await settleCancelled(attempt.id, runToken)
      else await settleFailure({ attemptId: attempt.id, runToken, code: 'lease_lost', message: 'The rewrite lease expired before the result could be saved. Retry to start a new attempt.' })
    }
  } catch (error) {
    if (abortReason === 'cancelled') await settleCancelled(attempt.id, runToken).catch(() => undefined)
    else await settleFailure({
        attemptId: attempt.id,
        runToken,
        code: abortReason === 'lease_lost' || abortReason === 'heartbeat_error'
          ? 'lease_lost'
          : abortReason === 'timeout' ? 'provider_timeout'
          : error instanceof AgentUnreachableError ? 'agent_unreachable' : 'request_error',
        message: abortReason === 'cancelled'
          ? 'The rewrite was cancelled by the operator.'
          : abortReason === 'lease_lost' || abortReason === 'heartbeat_error'
            ? 'The rewrite worker lost its lease heartbeat before the result could be saved.'
            : abortReason === 'timeout'
              ? 'The AI provider did not finish the rewrite before its configured time limit.'
            : error instanceof AgentUnreachableError ? 'The AI analysis service is unavailable.' : 'The rewrite request failed before completion.',
      }).catch(() => undefined)
  } finally {
    clearInterval(heartbeatTimer)
    clearTimeout(timeoutTimer)
    if (attempt.unitLeaseId) {
      await prisma.reamonCodeUnitLease.deleteMany({ where: { id: attempt.unitLeaseId } }).catch(() => undefined)
    }
  }
  return true
}

export async function dispatchQueuedCodeRewrites(input: { limit?: number; workerId?: string } = {}) {
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(input.limit as number))) : 1
  const workerId = input.workerId?.trim().slice(0, 128) || 'internal-dispatch'
  const staleBefore = new Date(Date.now() - MAX_REWRITE_TIMEOUT_MS - REWRITE_LEASE_GRACE_MS - STALE_JOB_GRACE_MS)
  const stale = await prisma.reamonCodeAttempt.findMany({
    where: {
      status: 'RUNNING',
      OR: [
        { leaseHeartbeatAt: { lt: staleBefore } },
        { leaseHeartbeatAt: null, createdAt: { lt: staleBefore } },
      ],
    },
    take: 100,
    select: { id: true, runToken: true, unitLeaseId: true },
  })
  let recovered = 0
  for (const attempt of stale) {
    const staleWhere = {
        id: attempt.id,
        status: 'RUNNING',
        runToken: attempt.runToken,
        OR: [
          { leaseHeartbeatAt: { lt: staleBefore } },
          { leaseHeartbeatAt: null, createdAt: { lt: staleBefore } },
        ],
      }
    const cancelled = await prisma.reamonCodeAttempt.updateMany({
      where: { ...staleWhere, cancelRequested: true },
      data: {
        status: 'CANCELLED', errorCode: 'cancelled',
        errorMessage: 'The rewrite was cancelled by the operator while its worker was unavailable.',
        completedAt: new Date(), runToken: null, leaseOwner: null, leaseHeartbeatAt: null,
      },
    })
    const interrupted = await prisma.reamonCodeAttempt.updateMany({
      where: { ...staleWhere, cancelRequested: false },
      data: {
        status: 'FAILED', errorCode: 'interrupted',
        errorMessage: 'The rewrite worker stopped before saving a result. Retry to start a new attempt.',
        completedAt: new Date(), runToken: null, leaseOwner: null, leaseHeartbeatAt: null,
      },
    })
    recovered += cancelled.count + interrupted.count
    if (cancelled.count + interrupted.count > 0 && attempt.unitLeaseId) {
      await prisma.reamonCodeUnitLease.deleteMany({ where: { id: attempt.unitLeaseId } })
    }
  }

  const queuedCandidates = await prisma.reamonCodeAttempt.findMany({
    where: { status: 'QUEUED' },
    orderBy: { createdAt: 'asc' },
    take: MAX_DEPENDENCY_CANDIDATES + 1,
    select: { id: true, projectId: true, artifactId: true, codeUnitId: true, scope: true, createdAt: true },
  })
  const dependencyPlan = await orderQueuedAttempts(queuedCandidates)
  const queued = dependencyPlan.complete
    ? dependencyPlan.ordered
      .filter((attempt) => !dependencyPlan.blockedAttemptIds.has(attempt.id))
      .slice(0, limit)
    : queuedCandidates
  const runnable = queued.slice(0, limit)
  const results = await Promise.all(runnable.map(async (attempt) => ({
    attemptId: attempt.id,
    claimed: await executeAttempt(attempt.id, workerId),
  })))
  return { recovered, selected: dependencyPlan.complete ? queued.length : results.length, workerId, results }
}

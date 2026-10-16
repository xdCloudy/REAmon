import { randomUUID } from 'node:crypto'
import prisma from '@/lib/prisma'
import { AgentUnreachableError, agentFetch } from '@/lib/agentFetch'

const MAX_BATCH_SIZE = 5
const MAX_RESULT_BYTES = 128 * 1024
const REWRITE_LEASE_GRACE_MS = 60_000
const MAX_REWRITE_TIMEOUT_MS = 5 * 60_000
const STALE_JOB_GRACE_MS = 60_000
const LEASE_HEARTBEAT_INTERVAL_MS = 15_000

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
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
    select: { id: true, projectId: true, status: true, requestPayload: true, timeoutMs: true, unitLeaseId: true },
  })
  if (!attempt || attempt.status !== 'QUEUED') return false

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

  const queued = await prisma.reamonCodeAttempt.findMany({
    where: { status: 'QUEUED' },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  })
  const results = []
  for (const attempt of queued) {
    results.push({ attemptId: attempt.id, claimed: await executeAttempt(attempt.id, workerId) })
  }
  return { recovered, selected: queued.length, workerId, results }
}

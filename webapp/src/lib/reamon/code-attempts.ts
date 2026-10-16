import prisma from '@/lib/prisma'

const MAX_REWRITE_TIMEOUT_MS = 5 * 60_000
const REWRITE_LEASE_GRACE_MS = 60_000
const HISTORY_CLEANUP_GRACE_MS = 60_000

export async function failInterruptedCodeAttempts(
  where: { projectId: string; artifactId: string; runKey: string; codeUnitId: string; sourceHash: string },
  before: Date,
) {
  return prisma.reamonCodeAttempt.updateMany({
    where: { ...where, status: 'RUNNING', createdAt: { lt: before } },
    data: {
      status: 'FAILED',
      errorCode: 'interrupted',
      errorMessage: 'The rewrite worker stopped before saving a result. Retry to start a new attempt.',
      completedAt: new Date(),
    },
  })
}

export async function failExpiredCodeAttemptsForHistory(
  where: { projectId: string; artifactId: string; runKey: string; codeUnitId: string; sourceHash: string },
) {
  const staleBefore = new Date(Date.now() - MAX_REWRITE_TIMEOUT_MS - REWRITE_LEASE_GRACE_MS - HISTORY_CLEANUP_GRACE_MS)
  return failInterruptedCodeAttempts(where, staleBefore)
}

export const codeRewriteLeaseGraceMs = REWRITE_LEASE_GRACE_MS

import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'

interface RouteParams { params: Promise<{ id: string; batchId: string }> }

export async function POST(_request: Request, { params }: RouteParams) {
  const { id: projectId, batchId } = await params
  if (!/^agent-[a-z0-9-]{10,80}$/i.test(batchId)) {
    return NextResponse.json({ error: 'Invalid function agent batch ID' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }

  const user = await requireEffectiveUser()
  if (user instanceof NextResponse) return user
  const access = await requireProjectAccess(user, projectId)
  if (access instanceof NextResponse) return access

  const batchWhere = { projectId, agentBatchId: batchId, scope: 'member' as const }
  const batchCount = await prisma.reamonCodeAttempt.count({ where: batchWhere })
  if (batchCount === 0) return NextResponse.json({ error: 'Function agent batch not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })

  const queuedAttempts = await prisma.reamonCodeAttempt.findMany({
    where: { ...batchWhere, status: 'QUEUED' },
    select: { id: true, unitLeaseId: true },
  })
  let cancelledQueued = 0
  for (const attempt of queuedAttempts) {
    const cancelled = await prisma.reamonCodeAttempt.updateMany({
      where: { id: attempt.id, ...batchWhere, status: 'QUEUED' },
      data: {
        status: 'CANCELLED',
        cancelRequested: true,
        errorCode: 'cancelled',
        errorMessage: 'The function agent batch was cancelled before this rewrite started.',
        completedAt: new Date(),
      },
    })
    if (cancelled.count === 1) {
      cancelledQueued += 1
      if (attempt.unitLeaseId) await prisma.reamonCodeUnitLease.deleteMany({ where: { id: attempt.unitLeaseId, projectId } })
    }
  }

  const running = await prisma.reamonCodeAttempt.updateMany({
    where: { ...batchWhere, status: 'RUNNING', cancelRequested: false },
    data: { cancelRequested: true },
  })
  const remaining = await prisma.reamonCodeAttempt.count({
    where: { ...batchWhere, status: { in: ['QUEUED', 'RUNNING'] } },
  })
  const result = { cancelledQueued, cancelRequestedRunning: running.count, remaining }
  return NextResponse.json({ batchId, ...result }, { headers: { 'Cache-Control': 'private, no-store' } })
}

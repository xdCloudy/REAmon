import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'

interface RouteParams { params: Promise<{ id: string; attemptId: string }> }

export async function POST(_request: Request, { params }: RouteParams) {
  const { id: projectId, attemptId } = await params
  const user = await requireEffectiveUser()
  if (user instanceof NextResponse) return user
  const access = await requireProjectAccess(user, projectId)
  if (access instanceof NextResponse) return access

  const cancelled = await prisma.reamonCodeAttempt.updateMany({
    where: { id: attemptId, projectId, status: 'QUEUED' },
    data: {
      status: 'CANCELLED',
      cancelRequested: true,
      errorCode: 'cancelled',
      errorMessage: 'The rewrite was cancelled by the operator before a worker started it.',
      completedAt: new Date(),
    },
  })
  if (cancelled.count === 1) {
    const attempt = await prisma.reamonCodeAttempt.findFirst({ where: { id: attemptId, projectId }, select: { unitLeaseId: true } })
    if (attempt?.unitLeaseId) await prisma.reamonCodeUnitLease.deleteMany({ where: { id: attempt.unitLeaseId } })
    return NextResponse.json({ attemptId, status: 'CANCELLED' }, { headers: { 'Cache-Control': 'private, no-store' } })
  }

  await prisma.reamonCodeAttempt.updateMany({
    where: { id: attemptId, projectId, status: 'RUNNING', cancelRequested: false },
    data: { cancelRequested: true },
  })
  const attempt = await prisma.reamonCodeAttempt.findFirst({
    where: { id: attemptId, projectId },
    select: { status: true, cancelRequested: true },
  })
  if (!attempt) return NextResponse.json({ error: 'Rewrite attempt not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
  return NextResponse.json({
    attemptId,
    status: attempt.status,
    cancelRequested: attempt.cancelRequested,
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}

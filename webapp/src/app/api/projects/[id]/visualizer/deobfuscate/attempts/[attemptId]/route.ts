import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'

interface RouteParams { params: Promise<{ id: string; attemptId: string }> }

export async function GET(_request: Request, { params }: RouteParams) {
  const { id: projectId, attemptId } = await params
  const user = await requireEffectiveUser()
  if (user instanceof NextResponse) return user
  const access = await requireProjectAccess(user, projectId)
  if (access instanceof NextResponse) return access

  const attempt = await prisma.reamonCodeAttempt.findFirst({
    where: { id: attemptId, projectId },
    select: {
      id: true,
      status: true,
      resultSource: true,
      providerName: true,
      modelIdentifier: true,
      errorMessage: true,
      syntaxValidated: true,
      validationStatus: true,
      validationMethod: true,
      validationMessage: true,
      createdAt: true,
      completedAt: true,
    },
  })
  if (!attempt) return NextResponse.json({ error: 'Rewrite attempt not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })

  return NextResponse.json({
    attemptId: attempt.id,
    status: attempt.status,
    ...(attempt.status === 'SUCCEEDED' ? {
      sourceCode: attempt.resultSource,
      providerName: attempt.providerName,
      model: attempt.modelIdentifier,
      syntaxValidated: attempt.syntaxValidated,
      validationStatus: attempt.validationStatus,
      validationMethod: attempt.validationMethod,
      validationMessage: attempt.validationMessage,
    } : {}),
    ...(attempt.status === 'FAILED' ? { error: attempt.errorMessage || 'The rewrite attempt failed' } : {}),
    createdAt: attempt.createdAt,
    completedAt: attempt.completedAt,
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}

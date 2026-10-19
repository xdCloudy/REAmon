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
      scope: true,
      cancelRequested: true,
      resultSource: true,
      rewriteHistory: true,
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
  let inputSource: string | undefined
  if (attempt.status === 'SUCCEEDED' && attempt.scope === 'member') {
    const storedRequest = await prisma.reamonCodeAttempt.findFirst({
      where: { id: attempt.id, projectId },
      select: { requestPayload: true },
    })
    const payload = storedRequest?.requestPayload
    if (payload && typeof payload === 'object' && !Array.isArray(payload)
      && 'source_code' in payload && typeof payload.source_code === 'string') {
      inputSource = payload.source_code
    }
  }

  return NextResponse.json({
    attemptId: attempt.id,
    status: attempt.status,
    cancelRequested: attempt.cancelRequested,
    ...(attempt.status === 'SUCCEEDED' ? {
      sourceCode: attempt.resultSource,
      rewriteHistory: attempt.rewriteHistory,
      ...(inputSource !== undefined ? { inputSource } : {}),
      providerName: attempt.providerName,
      model: attempt.modelIdentifier,
      syntaxValidated: attempt.syntaxValidated,
      validationStatus: attempt.validationStatus,
      validationMethod: attempt.validationMethod,
      validationMessage: attempt.validationMessage,
    } : {}),
    ...(attempt.status === 'FAILED' ? { error: attempt.errorMessage || 'The rewrite attempt failed', rewriteHistory: attempt.rewriteHistory } : {}),
    ...(attempt.status === 'CANCELLED' ? { error: attempt.errorMessage || 'The rewrite was cancelled' } : {}),
    createdAt: attempt.createdAt,
    completedAt: attempt.completedAt,
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}

import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'

interface RouteParams { params: Promise<{ id: string }> }

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function GET(request: Request, { params }: RouteParams) {
  const { id: projectId } = await params
  const user = await requireEffectiveUser()
  if (user instanceof NextResponse) return user
  const access = await requireProjectAccess(user, projectId)
  if (access instanceof NextResponse) return access

  const taskId = new URL(request.url).searchParams.get('taskId')?.trim() || ''
  if (!taskId || taskId.length > 128) {
    return NextResponse.json({ error: 'A completed analysis run is required' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  const selection = await getActiveWorkspaceImportSelection(projectId)
  const task = await prisma.task.findFirst({
    where: {
      id: taskId,
      projectId,
      capability: { in: ['decompile', 'disassemble'] },
      status: 'COMPLETED',
      artifact: { is: selection.artifactWhere },
    },
    select: { artifactId: true },
  })
  if (!task) return NextResponse.json({ error: 'Analysis run not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })

  const runKeyPrefix = `${projectId}/${task.artifactId}/${taskId}/`
  const latest = await prisma.reamonCodeAttempt.findFirst({
    where: {
      projectId,
      artifactId: task.artifactId,
      runKey: { startsWith: runKeyPrefix },
      scope: 'member',
      agentBatchId: { not: null },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { agentBatchId: true, runKey: true, createdAt: true },
  })
  const agentBatchId = latest?.agentBatchId
  if (!agentBatchId) return NextResponse.json({ batch: null }, { headers: { 'Cache-Control': 'no-store' } })

  const attempts = await prisma.reamonCodeAttempt.findMany({
    where: {
      projectId,
      artifactId: task.artifactId,
      runKey: latest.runKey,
      agentBatchId,
      scope: 'member',
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 10,
    select: {
      id: true,
      codeUnitId: true,
      unitName: true,
      language: true,
      status: true,
      cancelRequested: true,
      errorMessage: true,
      validationStatus: true,
      validationMethod: true,
      createdAt: true,
      completedAt: true,
      requestPayload: true,
    },
  })
  return NextResponse.json({
    batch: {
      id: agentBatchId,
      createdAt: latest.createdAt.toISOString(),
      attempts: attempts.map((attempt) => {
        const payload = plainObject(attempt.requestPayload)
        return {
          id: attempt.id,
          codeUnitId: attempt.codeUnitId,
          unitName: attempt.unitName,
          language: attempt.language,
          memberName: typeof payload.member_name === 'string' ? payload.member_name.slice(0, 500) : 'Function or method',
          status: attempt.status,
          cancelRequested: attempt.cancelRequested,
          errorMessage: attempt.errorMessage,
          validationStatus: attempt.validationStatus,
          validationMethod: attempt.validationMethod,
          createdAt: attempt.createdAt.toISOString(),
          completedAt: attempt.completedAt?.toISOString() ?? null,
        }
      }),
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}

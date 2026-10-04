import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { CODE_UNIT_OBSERVATION_TYPE, CODE_UNIT_QUERY_LIMIT, normalizeCodeUnit, summarizeCodeUnits } from '@/lib/reamon/code-units'

interface RouteParams { params: Promise<{ id: string }> }

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const decompileTasks = await prisma.task.findMany({
      where: {
        projectId,
        capability: 'decompile',
        status: 'COMPLETED',
        artifact: { is: selection.artifactWhere },
      },
      orderBy: { completedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        title: true,
        createdAt: true,
        completedAt: true,
        artifact: { select: { originalName: true, relativePath: true } },
      },
    })
    const decompileTaskIds = decompileTasks.map((task) => task.id)
    const observationCounts = decompileTaskIds.length
      ? await prisma.reamonObservation.groupBy({
        by: ['taskId'],
        where: {
          projectId,
          type: CODE_UNIT_OBSERVATION_TYPE,
          taskId: { in: decompileTaskIds },
          artifact: { is: selection.artifactWhere },
        },
        _count: { _all: true },
      })
      : []
    const countByTaskId = new Map(observationCounts.map((row) => [row.taskId, row._count._all]))
    const runs = decompileTasks
      .map((task) => ({
        id: task.id,
        title: task.title,
        createdAt: task.createdAt.toISOString(),
        completedAt: task.completedAt?.toISOString() || null,
        artifactName: task.artifact?.relativePath || task.artifact?.originalName || 'Unknown artifact',
        codeUnitCount: countByTaskId.get(task.id) || 0,
      }))
      .filter((run) => run.codeUnitCount > 0)
    const requestedTaskId = new URL(request.url).searchParams.get('taskId')?.trim() || null
    if (requestedTaskId && !runs.some((run) => run.id === requestedTaskId)) {
      return NextResponse.json({ error: 'Analysis run not found' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
    }
    const selectedRunId = requestedTaskId || runs[0]?.id || null
    const where = {
      projectId,
      type: CODE_UNIT_OBSERVATION_TYPE,
      artifact: { is: selection.artifactWhere },
      ...(selectedRunId ? { taskId: selectedRunId } : {}),
    }
    const [rows, total] = await Promise.all([
      prisma.reamonObservation.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { stableKey: 'asc' }],
        take: CODE_UNIT_QUERY_LIMIT + 1,
        select: {
          id: true,
          stableKey: true,
          label: true,
          source: true,
          artifactId: true,
          updatedAt: true,
          attributes: true,
          artifact: { select: { relativePath: true, originalName: true } },
        },
      }),
      prisma.reamonObservation.count({ where }),
    ])

    const units = rows.slice(0, CODE_UNIT_QUERY_LIMIT)
      .map(normalizeCodeUnit)
      .filter((unit) => unit !== null)
    return NextResponse.json({
      units,
      total,
      hasMore: total > CODE_UNIT_QUERY_LIMIT,
      runs,
      selectedRunId,
      summary: summarizeCodeUnits(units),
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to load REAmon code visualizer units:', error)
    return NextResponse.json({ error: 'Failed to load code visualizer units' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

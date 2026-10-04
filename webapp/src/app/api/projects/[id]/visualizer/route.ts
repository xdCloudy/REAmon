import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { CODE_UNIT_OBSERVATION_TYPE, CODE_UNIT_QUERY_LIMIT, normalizeCodeUnit, summarizeCodeUnits } from '@/lib/reamon/code-units'

interface RouteParams { params: Promise<{ id: string }> }

function resultRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

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
        capability: { in: ['decompile', 'disassemble'] },
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
        result: true,
        provider: { select: { pluginId: true } },
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
      .map((task) => {
        const result = resultRecord(task.result)
        const codeUnitCount = countByTaskId.get(task.id) || 0
        const isWasm = task.provider?.pluginId === 'reamon-wabt'
        const discoveredUnitCount = finiteCount(isWasm ? result.wasmFunctionCount : result.decompiledClassCount ?? result.decompiledFunctionCount)
        const returnedUnitCount = finiteCount(result.returnedClassCount ?? result.returnedFunctionCount) ?? codeUnitCount
        const indexedUnitCount = Math.min(codeUnitCount, returnedUnitCount)
        const unitLabel = task.provider?.pluginId === 'reamon-jadx' ? 'classes' : task.provider?.pluginId === 'reamon-ghidra' || isWasm ? 'functions' : 'code units'
        return {
          id: task.id,
          title: task.title,
          createdAt: task.createdAt.toISOString(),
          completedAt: task.completedAt?.toISOString() || null,
          artifactName: task.artifact?.relativePath || task.artifact?.originalName || 'Unknown artifact',
          providerId: task.provider?.pluginId || null,
          codeUnitCount,
          unitLabel,
          discoveredUnitCount,
          returnedUnitCount,
          indexedUnitCount,
          codeBytes: finiteCount(result.codeBytes),
          linkPercent: discoveredUnitCount ? Math.min(100, Math.round((indexedUnitCount / discoveredUnitCount) * 100)) : null,
          truncated: result.truncated === true || (discoveredUnitCount !== null && returnedUnitCount < discoveredUnitCount),
          warnings: typeof result.warnings === 'string' ? result.warnings.slice(0, 4000) : '',
          failedUnitCount: finiteCount(result.failedFunctionCount),
          visitedUnitCount: finiteCount(result.visitedFunctionCount),
        }
      })
      .filter((run) => run.codeUnitCount > 0)
    const searchParams = new URL(request.url).searchParams
    const requestedTaskId = searchParams.get('taskId')?.trim() || null
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
    const cursorId = searchParams.get('cursor')?.trim() || null
    if (cursorId && cursorId.length > 128) {
      return NextResponse.json({ error: 'Invalid code unit cursor' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }
    if (cursorId) {
      const cursor = await prisma.reamonObservation.findFirst({ where: { ...where, id: cursorId }, select: { id: true } })
      if (!cursor) return NextResponse.json({ error: 'Code unit cursor is outside this analysis run' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }
    const [rows, total] = await Promise.all([
      prisma.reamonObservation.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { stableKey: 'asc' }, { id: 'asc' }],
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
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

    const pageRows = rows.slice(0, CODE_UNIT_QUERY_LIMIT)
    const units = pageRows.map(normalizeCodeUnit).filter((unit) => unit !== null)
    const nextCursor = rows.length > CODE_UNIT_QUERY_LIMIT ? pageRows.at(-1)?.id || null : null
    return NextResponse.json({
      units,
      total,
      hasMore: nextCursor !== null,
      nextCursor,
      runs,
      selectedRunId,
      summary: summarizeCodeUnits(units),
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to load REAmon code visualizer units:', error)
    return NextResponse.json({ error: 'Failed to load code visualizer units' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { CODE_UNIT_OBSERVATION_TYPE, MAINTAINED_SOURCE_OBSERVATION_SOURCE, MAINTAINED_SOURCE_OBSERVATION_TYPE } from '@/lib/reamon/code-units'

interface RouteParams { params: Promise<{ id: string }> }

const PAGE_SIZE = 5000

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const taskId = new URL(request.url).searchParams.get('taskId')?.trim() || ''
    if (!taskId || taskId.length > 128) {
      return NextResponse.json({ error: 'A completed analysis run is required' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
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
      select: { id: true },
    })
    if (!task) return NextResponse.json({ error: 'Analysis run not found' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })

    const codeUnitWhere = {
      projectId,
      taskId: task.id,
      type: CODE_UNIT_OBSERVATION_TYPE,
      artifact: { is: selection.artifactWhere },
    }
    let cursor: string | undefined
    let codeUnitCount = 0
    let maintainedUnitCount = 0
    while (true) {
      const rows = await prisma.reamonObservation.findMany({
        where: { ...codeUnitWhere, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        select: { id: true },
      })
      if (rows.length === 0) break
      codeUnitCount += rows.length
      const maintained = await prisma.reamonObservation.findMany({
        where: {
          projectId,
          source: MAINTAINED_SOURCE_OBSERVATION_SOURCE,
          type: MAINTAINED_SOURCE_OBSERVATION_TYPE,
          artifact: { is: selection.artifactWhere },
          stableKey: { in: rows.map((row) => row.id) },
        },
        select: { stableKey: true },
      })
      maintainedUnitCount += maintained.length
      if (rows.length < PAGE_SIZE) break
      cursor = rows.at(-1)?.id
    }

    return NextResponse.json({
      taskId: task.id,
      codeUnitCount,
      maintainedUnitCount,
      coveragePercent: codeUnitCount > 0 ? Math.round((maintainedUnitCount / codeUnitCount) * 100) : 0,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to load REAmon maintained-source coverage:', error)
    return NextResponse.json({ error: 'Failed to load maintained-source coverage' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { CODE_UNIT_OBSERVATION_TYPE, CODE_UNIT_QUERY_LIMIT, normalizeCodeUnit, summarizeCodeUnits } from '@/lib/reamon/code-units'

interface RouteParams { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const where = {
      projectId,
      type: CODE_UNIT_OBSERVATION_TYPE,
      artifact: { is: selection.artifactWhere },
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
      summary: summarizeCodeUnits(units),
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to load REAmon code visualizer units:', error)
    return NextResponse.json({ error: 'Failed to load code visualizer units' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

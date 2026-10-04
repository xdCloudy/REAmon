import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { normalizeCodeUnit } from '@/lib/reamon/code-units'

interface RouteParams { params: Promise<{ id: string }> }

const MAX_EDGES = 200
const NO_STORE = { 'Cache-Control': 'private, no-store' }

function attributesRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown, fallback: string, maxLength = 500): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const search = new URL(request.url).searchParams
    const taskId = search.get('taskId')?.trim() || ''
    const unitId = search.get('unitId')?.trim() || ''
    if (!taskId || taskId.length > 128 || !unitId || unitId.length > 128) {
      return NextResponse.json({ error: 'A valid Ghidra run and function are required' }, { status: 400, headers: NO_STORE })
    }

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        projectId,
        capability: 'decompile',
        status: 'COMPLETED',
        provider: { is: { pluginId: 'reamon-ghidra' } },
        artifact: { is: selection.artifactWhere },
      },
      select: { id: true, artifactId: true },
    })
    if (!task?.artifactId) return NextResponse.json({ error: 'Ghidra analysis run not found' }, { status: 404, headers: NO_STORE })

    const focusRow = await prisma.reamonObservation.findFirst({
      where: {
        id: unitId,
        projectId,
        taskId: task.id,
        artifactId: task.artifactId,
        type: 'code_unit',
        source: 'reamon-ghidra',
        artifact: { is: selection.artifactWhere },
      },
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
    })
    const focusUnit = focusRow && normalizeCodeUnit(focusRow)
    if (!focusRow || !focusUnit || focusUnit.unitType !== 'function') {
      return NextResponse.json({ error: 'Function is outside this Ghidra analysis run' }, { status: 404, headers: NO_STORE })
    }

    const edgeRows = await prisma.reamonObservation.findMany({
      where: {
        projectId,
        taskId: task.id,
        artifactId: task.artifactId,
        kind: 'relationship',
        type: 'calls',
        source: 'reamon-ghidra',
        OR: [{ fromKey: focusRow.stableKey }, { toKey: focusRow.stableKey }],
      },
      orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
      take: MAX_EDGES + 1,
      select: { id: true, stableKey: true, label: true, fromKey: true, toKey: true },
    })
    const truncated = edgeRows.length > MAX_EDGES
    const edges = edgeRows.slice(0, MAX_EDGES).filter((edge) => edge.fromKey && edge.toKey)
    const endpointKeys = [...new Set([focusRow.stableKey, ...edges.flatMap((edge) => [edge.fromKey!, edge.toKey!])])]
    const nodeRows = endpointKeys.length > 1
      ? await prisma.reamonObservation.findMany({
        where: {
          projectId,
          taskId: task.id,
          artifactId: task.artifactId,
          source: 'reamon-ghidra',
          stableKey: { in: endpointKeys },
          type: { in: ['code_unit', 'function'] },
        },
        select: {
          id: true,
          stableKey: true,
          label: true,
          source: true,
          artifactId: true,
          type: true,
          updatedAt: true,
          attributes: true,
          artifact: { select: { relativePath: true, originalName: true } },
        },
      })
      : []
    const byKey = new Map(nodeRows.map((node) => [node.stableKey, node]))
    const nodes = endpointKeys.flatMap((key) => {
      const row = byKey.get(key)
      if (!row) return []
      const attributes = attributesRecord(row.attributes)
      const codeUnit = row.type === 'code_unit' ? normalizeCodeUnit(row) : null
      return [{
        key,
        label: text(attributes.qualifiedName ?? attributes.name ?? row.label, key === focusRow.stableKey ? focusUnit.name : 'Unknown function'),
        address: text(attributes.address, '', 128) || null,
        codeUnit,
        isFocus: key === focusRow.stableKey,
      }]
    })
    const nodeKeys = new Set(nodes.map((node) => node.key))
    const visibleEdges = edges
      .filter((edge) => nodeKeys.has(edge.fromKey!) && nodeKeys.has(edge.toKey!))
      .map((edge) => ({ id: edge.id, fromKey: edge.fromKey!, toKey: edge.toKey!, label: edge.label || 'calls' }))

    return NextResponse.json({ focusKey: focusRow.stableKey, nodes, edges: visibleEdges, truncated }, { headers: NO_STORE })
  } catch (error) {
    console.error('Failed to load Ghidra call graph:', error)
    return NextResponse.json({ error: 'Failed to load call graph' }, { status: 500, headers: NO_STORE })
  }
}

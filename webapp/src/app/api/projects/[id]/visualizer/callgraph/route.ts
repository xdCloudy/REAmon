import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { normalizeCodeUnit } from '@/lib/reamon/code-units'

interface RouteParams { params: Promise<{ id: string }> }

const MAX_EDGES = 400
const MAX_JADX_UNITS = 20_000
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
    const requestedGraphType = search.get('graphType')
    const runGraph = search.get('view') === 'graph'
    if (!taskId || taskId.length > 128 || (unitId.length > 128) || (!unitId && !runGraph)) {
      return NextResponse.json({ error: 'A valid code analysis run is required' }, { status: 400, headers: NO_STORE })
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
      select: { id: true, artifactId: true, provider: { select: { pluginId: true } } },
    })
    if (!task?.artifactId) return NextResponse.json({ error: 'Decompilation run not found' }, { status: 404, headers: NO_STORE })

    if (task.provider?.pluginId === 'reamon-jadx' && (requestedGraphType === 'class_dependencies' || requestedGraphType === null)) {
      const classRows = await prisma.reamonObservation.findMany({
        where: {
          projectId,
          taskId: task.id,
          artifactId: task.artifactId,
          type: 'code_unit',
          source: 'reamon-jadx',
          artifact: { is: selection.artifactWhere },
        },
        orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
        take: MAX_JADX_UNITS + 1,
        select: {
          id: true, stableKey: true, label: true, source: true, artifactId: true, updatedAt: true, attributes: true,
          artifact: { select: { relativePath: true, originalName: true } },
        },
      })
      const truncated = classRows.length > MAX_JADX_UNITS
      const classes = classRows.slice(0, MAX_JADX_UNITS).flatMap((row) => {
        const codeUnit = normalizeCodeUnit(row)
        return codeUnit?.unitType === 'class' ? [{ row, codeUnit }] : []
      }).sort((left, right) => left.codeUnit.name.localeCompare(right.codeUnit.name) || left.row.stableKey.localeCompare(right.row.stableKey))
      const byName = new Map(classes.map((entry) => [entry.codeUnit.name, entry]))
      const focus = unitId ? classes.find(({ row, codeUnit }) => codeUnit.id === unitId || row.stableKey === unitId) : undefined
      if (unitId && !focus) {
        return NextResponse.json({ error: 'Class is outside this JADX analysis run' }, { status: 404, headers: NO_STORE })
      }
      const nodes = new Map<string, { key: string; label: string; address: string | null; codeUnit: NonNullable<ReturnType<typeof normalizeCodeUnit>>; isFocus: boolean }>()
      const edges: Array<{ id: string; fromKey: string; toKey: string; label: string }> = []
      let edgeLimitReached = false
      for (const { row, codeUnit } of classes) {
        const references = Array.isArray(codeUnit.classReferences) ? codeUnit.classReferences : []
        for (const reference of references) {
          const target = byName.get(reference)
          if (!target || target.codeUnit.id === codeUnit.id) continue
          if (focus && focus.codeUnit.id !== codeUnit.id && focus.codeUnit.id !== target.codeUnit.id) continue
          const edge = { id: `dependency:${row.stableKey}:${target.row.stableKey}`, fromKey: row.stableKey, toKey: target.row.stableKey, label: 'depends on' }
          for (const [key, unit] of [[edge.fromKey, codeUnit], [edge.toKey, target.codeUnit]] as const) {
            if (!nodes.has(key)) nodes.set(key, {
              key, label: unit.name, address: null, codeUnit: unit, isFocus: unit.id === focus?.codeUnit.id,
            })
          }
          edges.push(edge)
          if (edges.length > MAX_EDGES) {
            edges.pop()
            edgeLimitReached = true
            break
          }
        }
        if (edgeLimitReached) break
      }
      return NextResponse.json({ graphType: 'class_dependencies', focusKey: focus?.row.stableKey || null, nodes: [...nodes.values()], edges, truncated: truncated || edgeLimitReached }, { headers: NO_STORE })
    }

    const observationSource = task.provider?.pluginId || 'reamon-ghidra'
    const focusRow = unitId ? await prisma.reamonObservation.findFirst({
      where: {
        OR: [{ id: unitId }, { stableKey: unitId }],
        projectId,
        taskId: task.id,
        artifactId: task.artifactId,
        type: { in: ['code_unit', 'function'] },
        source: observationSource,
        artifact: { is: selection.artifactWhere },
      },
      select: {
        id: true,
        stableKey: true,
        type: true,
        label: true,
        source: true,
        artifactId: true,
        updatedAt: true,
        attributes: true,
        artifact: { select: { relativePath: true, originalName: true } },
      },
    }) : null
    const focusUnit = focusRow?.type === 'code_unit' ? normalizeCodeUnit(focusRow) : null
    if (unitId && (!focusRow || (focusRow.type !== 'function' && focusUnit?.unitType !== 'function'))) {
      return NextResponse.json({ error: 'Function is outside this analysis run' }, { status: 404, headers: NO_STORE })
    }

    const edgeRows = await prisma.reamonObservation.findMany({
      where: {
        projectId,
        taskId: task.id,
        artifactId: task.artifactId,
        kind: 'relationship',
        type: 'calls',
        source: observationSource,
        ...(focusRow ? { OR: [{ fromKey: focusRow.stableKey }, { toKey: focusRow.stableKey }] } : {}),
      },
      orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
      take: MAX_EDGES + 1,
      select: { id: true, stableKey: true, label: true, fromKey: true, toKey: true },
    })
    const truncated = edgeRows.length > MAX_EDGES
    const edges = edgeRows.slice(0, MAX_EDGES).filter((edge) => edge.fromKey && edge.toKey)
    const endpointKeys = [...new Set([...(focusRow ? [focusRow.stableKey] : []), ...edges.flatMap((edge) => [edge.fromKey!, edge.toKey!])])]
    const nodeRows = endpointKeys.length > 0
      ? await prisma.reamonObservation.findMany({
        where: {
          projectId,
          taskId: task.id,
          artifactId: task.artifactId,
          source: observationSource,
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
    const parentUnitKeys = [...new Set(nodeRows.flatMap((node) => {
      if (node.type !== 'function') return []
      const parentKey = attributesRecord(node.attributes).parentCodeUnitKey
      return typeof parentKey === 'string' ? [parentKey] : []
    }))]
    const parentUnitRows = parentUnitKeys.length ? await prisma.reamonObservation.findMany({
      where: {
        projectId,
        taskId: task.id,
        artifactId: task.artifactId,
        source: observationSource,
        type: 'code_unit',
        stableKey: { in: parentUnitKeys },
      },
      select: {
        id: true, stableKey: true, label: true, source: true, artifactId: true, updatedAt: true, attributes: true,
        artifact: { select: { relativePath: true, originalName: true } },
      },
    }) : []
    const parentByKey = new Map(parentUnitRows.map((node) => [node.stableKey, node]))
    const byKey = new Map(nodeRows.map((node) => [node.stableKey, node]))
    const nodes = endpointKeys.flatMap((key) => {
      const row = byKey.get(key)
      if (!row) return []
      const attributes = attributesRecord(row.attributes)
      const parentKey = typeof attributes.parentCodeUnitKey === 'string' ? attributes.parentCodeUnitKey : ''
      const parentRow = parentKey ? parentByKey.get(parentKey) : undefined
      const codeUnit = row.type === 'code_unit'
        ? normalizeCodeUnit(row)
        : parentRow ? normalizeCodeUnit(parentRow) : null
      return [{
        key,
        label: text(attributes.qualifiedName ?? attributes.name ?? row.label, key === focusRow?.stableKey ? focusUnit?.name || 'Selected function' : 'Unknown function'),
        address: text(attributes.address, '', 128) || null,
        codeUnit,
        isFocus: key === focusRow?.stableKey,
      }]
    })
    const nodeKeys = new Set(nodes.map((node) => node.key))
    const visibleEdges = edges
      .filter((edge) => nodeKeys.has(edge.fromKey!) && nodeKeys.has(edge.toKey!))
      .map((edge) => ({ id: edge.id, fromKey: edge.fromKey!, toKey: edge.toKey!, label: edge.label || 'calls' }))

    return NextResponse.json({ graphType: 'function_calls', focusKey: focusRow?.stableKey || null, nodes, edges: visibleEdges, truncated }, { headers: NO_STORE })
  } catch (error) {
    console.error('Failed to load analysis call graph:', error)
    return NextResponse.json({ error: 'Failed to load call graph' }, { status: 500, headers: NO_STORE })
  }
}

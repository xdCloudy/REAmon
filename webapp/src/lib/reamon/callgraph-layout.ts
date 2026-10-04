import { MarkerType, type Edge, type Node } from '@xyflow/react'
import type { CodeUnit } from './code-units'

export interface CallGraphRecord {
  key: string
  label: string
  address: string | null
  codeUnit: CodeUnit | null
  isFocus: boolean
}

export interface CallGraphRelationship {
  id: string
  fromKey: string
  toKey: string
  label: string
}

export interface FunctionGraphNodeData extends Record<string, unknown> {
  label: string
  address: string | null
  codeUnit: CodeUnit | null
  isFocus: boolean
}

export type FunctionGraphNode = Node<FunctionGraphNodeData, 'functionGraphNode'>
export type FunctionGraphEdge = Edge

function directedDistances(start: string, edges: CallGraphRelationship[], reverse: boolean): Map<string, number> {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const from = reverse ? edge.toKey : edge.fromKey
    const to = reverse ? edge.fromKey : edge.toKey
    const targets = adjacency.get(from) || []
    targets.push(to)
    adjacency.set(from, targets)
  }

  const distances = new Map<string, number>([[start, 0]])
  const queue = [start]
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    const nextDistance = (distances.get(current) || 0) + 1
    for (const next of adjacency.get(current) || []) {
      if (distances.has(next)) continue
      distances.set(next, nextDistance)
      queue.push(next)
    }
  }
  return distances
}

export function layoutCallGraph(
  records: CallGraphRecord[],
  relationships: CallGraphRelationship[],
  requestedFocusKey?: string | null,
): { nodes: FunctionGraphNode[]; edges: FunctionGraphEdge[]; focusKey: string | null } {
  const byKey = new Map(records.map((node) => [node.key, node]))
  if (!records.length) return { nodes: [], edges: [], focusKey: null }

  const degree = new Map<string, number>()
  for (const edge of relationships) {
    degree.set(edge.fromKey, (degree.get(edge.fromKey) || 0) + 1)
    degree.set(edge.toKey, (degree.get(edge.toKey) || 0) + 1)
  }
  const focusKey = requestedFocusKey && byKey.has(requestedFocusKey)
    ? requestedFocusKey
    : [...records].sort((left, right) => (degree.get(right.key) || 0) - (degree.get(left.key) || 0) || left.label.localeCompare(right.label))[0].key
  const outgoing = directedDistances(focusKey, relationships, false)
  const incoming = directedDistances(focusKey, relationships, true)
  const columns = new Map<number, CallGraphRecord[]>()
  let outerColumn = 1

  for (const record of records) {
    const outDistance = outgoing.get(record.key)
    const inDistance = incoming.get(record.key)
    let column: number
    if (record.key === focusKey) column = 0
    else if (outDistance !== undefined && (inDistance === undefined || outDistance <= inDistance)) column = outDistance
    else if (inDistance !== undefined) column = -inDistance
    else column = 0
    outerColumn = Math.max(outerColumn, Math.abs(column))
    const group = columns.get(column) || []
    group.push(record)
    columns.set(column, group)
  }

  const disconnected = columns.get(0)?.filter((node) => node.key !== focusKey) || []
  if (disconnected.length) {
    columns.set(0, (columns.get(0) || []).filter((node) => node.key === focusKey))
    columns.set(outerColumn + 1, disconnected)
  }

  const positioned: FunctionGraphNode[] = []
  for (const [column, group] of columns) {
    group.sort((left, right) => left.label.localeCompare(right.label) || left.key.localeCompare(right.key))
    group.forEach((record, index) => positioned.push({
      id: record.key,
      type: 'functionGraphNode',
      position: { x: column * 260, y: (index - (group.length - 1) / 2) * 130 },
      width: 210,
      height: 76,
      data: {
        label: record.label,
        address: record.address,
        codeUnit: record.codeUnit,
        isFocus: record.key === focusKey,
      },
    }))
  }

  const visibleKeys = new Set(positioned.map((node) => node.id))
  const flowEdges = relationships
    .filter((edge) => visibleKeys.has(edge.fromKey) && visibleKeys.has(edge.toKey))
    .map((edge): FunctionGraphEdge => ({
      id: edge.id,
      source: edge.fromKey,
      target: edge.toKey,
      type: 'smoothstep',
      label: edge.label || 'calls',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: '#61aeea', strokeWidth: 1.5 },
      labelStyle: { fill: '#b7c7d9', fontSize: 10 },
      labelBgStyle: { fill: '#111722', fillOpacity: 0.9 },
    }))

  return { nodes: positioned, edges: flowEdges, focusKey }
}

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

const MAX_NEIGHBORS_PER_DIRECTION = 8
const GRAPH_COLUMN_GAP = 320
const GRAPH_ROW_GAP = 104

export function layoutCallGraph(
  records: CallGraphRecord[],
  relationships: CallGraphRelationship[],
  requestedFocusKey?: string | null,
): { nodes: FunctionGraphNode[]; edges: FunctionGraphEdge[]; focusKey: string | null; hiddenNodeCount: number } {
  const byKey = new Map(records.map((node) => [node.key, node]))
  if (!records.length) return { nodes: [], edges: [], focusKey: null, hiddenNodeCount: 0 }

  const degree = new Map<string, number>()
  for (const edge of relationships) {
    degree.set(edge.fromKey, (degree.get(edge.fromKey) || 0) + 1)
    degree.set(edge.toKey, (degree.get(edge.toKey) || 0) + 1)
  }
  const focusKey = requestedFocusKey && byKey.has(requestedFocusKey)
    ? requestedFocusKey
    : [...records].sort((left, right) => (degree.get(right.key) || 0) - (degree.get(left.key) || 0) || left.label.localeCompare(right.label))[0].key
  const incomingKeys = new Set(relationships.filter((edge) => edge.toKey === focusKey).map((edge) => edge.fromKey))
  const outgoingKeys = new Set(relationships.filter((edge) => edge.fromKey === focusKey).map((edge) => edge.toKey))
  const compareNeighbors = (leftKey: string, rightKey: string) =>
    (byKey.get(leftKey)?.label || leftKey).localeCompare(byKey.get(rightKey)?.label || rightKey) || leftKey.localeCompare(rightKey)
  const incoming = [...incomingKeys].filter((key) => byKey.has(key) && key !== focusKey).sort(compareNeighbors)
  const outgoing = [...outgoingKeys].filter((key) => byKey.has(key) && key !== focusKey && !incomingKeys.has(key)).sort(compareNeighbors)
  const visibleIncoming = incoming.slice(0, MAX_NEIGHBORS_PER_DIRECTION)
  const visibleOutgoing = outgoing.slice(0, MAX_NEIGHBORS_PER_DIRECTION)
  const visibleKeys = new Set([focusKey, ...visibleIncoming, ...visibleOutgoing])
  const columns: Array<{ column: number; keys: string[] }> = [
    { column: -1, keys: visibleIncoming },
    { column: 1, keys: visibleOutgoing },
  ]

  const positioned: FunctionGraphNode[] = []
  for (const { column, keys } of columns) {
    keys.forEach((key, index) => {
      const record = byKey.get(key)!
      positioned.push({
      id: record.key,
      type: 'functionGraphNode',
      position: { x: column * GRAPH_COLUMN_GAP, y: (index - (keys.length - 1) / 2) * GRAPH_ROW_GAP },
      width: 210,
      height: 76,
      data: {
        label: record.label,
        address: record.address,
        codeUnit: record.codeUnit,
        isFocus: record.key === focusKey,
      },
      })
    })
  }
  const focusRecord = byKey.get(focusKey)!
  positioned.push({
    id: focusRecord.key,
    type: 'functionGraphNode',
    position: { x: 0, y: 0 },
    width: 210,
    height: 76,
    data: {
      label: focusRecord.label,
      address: focusRecord.address,
      codeUnit: focusRecord.codeUnit,
      isFocus: true,
    },
  })

  const flowEdges = relationships
    .filter((edge) => visibleKeys.has(edge.fromKey) && visibleKeys.has(edge.toKey) && (edge.fromKey === focusKey || edge.toKey === focusKey))
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

  return { nodes: positioned, edges: flowEdges, focusKey, hiddenNodeCount: records.length - visibleKeys.size }
}

import { describe, expect, test } from 'vitest'
import { layoutCallGraph, type CallGraphRecord, type CallGraphRelationship } from './callgraph-layout'

const records: CallGraphRecord[] = [
  { key: 'main', label: 'main', address: '0x1000', codeUnit: null, isFocus: false },
  { key: 'helper', label: 'helper', address: '0x1080', codeUnit: null, isFocus: false },
  { key: 'caller', label: 'caller', address: '0x0800', codeUnit: null, isFocus: false },
  { key: 'orphan', label: 'orphan', address: '0x2000', codeUnit: null, isFocus: false },
]

const relationships: CallGraphRelationship[] = [
  { id: 'edge-1', fromKey: 'main', toKey: 'helper', label: 'main calls helper' },
  { id: 'edge-2', fromKey: 'caller', toKey: 'main', label: 'caller calls main' },
]

describe('layoutCallGraph', () => {
  test('places callers left, callees right, and the selected function in the center', () => {
    const layout = layoutCallGraph(records, relationships, 'main')
    const positions = new Map(layout.nodes.map((node) => [node.id, node.position]))

    expect(layout.focusKey).toBe('main')
    expect(positions.get('caller')?.x).toBeLessThan(0)
    expect(positions.get('main')?.x).toBe(0)
    expect(positions.get('helper')?.x).toBeGreaterThan(0)
    expect(layout.edges.map((edge) => [edge.source, edge.target])).toEqual([['main', 'helper'], ['caller', 'main']])
  })

  test('selects a useful hub when no function is focused and keeps disconnected nodes visible', () => {
    const layout = layoutCallGraph(records, relationships)
    const positions = new Map(layout.nodes.map((node) => [node.id, node.position]))

    expect(layout.focusKey).toBe('main')
    expect(positions.get('orphan')?.x).toBeGreaterThan(positions.get('helper')?.x || 0)
  })

  test('returns an empty layout for a run without relationships', () => {
    expect(layoutCallGraph([], [])).toEqual({ nodes: [], edges: [], focusKey: null })
  })
})

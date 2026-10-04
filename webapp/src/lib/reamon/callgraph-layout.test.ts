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

  test('selects a useful hub when no function is focused and omits disconnected nodes', () => {
    const layout = layoutCallGraph(records, relationships)
    const positions = new Map(layout.nodes.map((node) => [node.id, node.position]))

    expect(layout.focusKey).toBe('main')
    expect(positions.has('orphan')).toBe(false)
    expect(layout.hiddenNodeCount).toBe(1)
  })

  test('returns an empty layout for a run without relationships', () => {
    expect(layoutCallGraph([], [])).toEqual({ nodes: [], edges: [], focusKey: null, hiddenNodeCount: 0 })
  })

  test('keeps high-degree neighborhoods at a readable size', () => {
    const manyNeighbors = Array.from({ length: 30 }, (_, index) => ({
      key: `helper-${index}`,
      label: `helper-${index}`,
      address: null,
      codeUnit: null,
      isFocus: false,
    }))
    const manyEdges = manyNeighbors.map((node) => ({
      id: `edge-${node.key}`,
      fromKey: 'main',
      toKey: node.key,
      label: 'calls',
    }))
    const layout = layoutCallGraph([{ ...records[0], codeUnit: null }, ...manyNeighbors], manyEdges, 'main')

    expect(layout.nodes).toHaveLength(9)
    expect(layout.edges).toHaveLength(8)
    expect(layout.hiddenNodeCount).toBe(22)
    expect(Math.max(...layout.nodes.map((node) => Math.abs(node.position.y)))).toBeLessThan(500)
  })
})

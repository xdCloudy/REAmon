'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useReactFlow,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { CodeUnit } from '@/lib/reamon/code-units'
import { layoutCallGraph, type CallGraphRecord, type CallGraphRelationship, type FunctionGraphNode, type FunctionGraphNodeData } from '@/lib/reamon/callgraph-layout'
import styles from './WorkspaceCodeVisualizer.module.css'

interface GraphNodeData extends FunctionGraphNodeData {
  onOpen?: (unit: CodeUnit, graphKey: string) => void
  onFocus?: (graphKey: string) => void
  graphType?: 'function_calls' | 'class_dependencies' | 'member_references'
}

type GraphFlowNode = FunctionGraphNode & { data: GraphNodeData }

function FunctionNode({ data, selected, id }: NodeProps<GraphFlowNode>) {
  const nodeCaption = data.nodeType === 'field'
    ? 'Referenced field'
    : data.nodeType === 'string_literal' ? 'String literal' : 'External or not decompiled'
  const label = <>
    <strong>{data.label}</strong>
    {data.address && <small>{data.address}</small>}
    {!data.codeUnit && <small>{nodeCaption}</small>}
  </>
  const className = `${styles.flowNode} ${data.isFocus ? styles.flowNodeFocus : ''} ${selected ? styles.flowNodeSelected : ''} ${!data.codeUnit ? styles.flowNodeExternal : ''}`

  return <>
    <Handle type="target" position={Position.Left} />
    {data.codeUnit
      ? <button type="button" className={className} onClick={() => data.onOpen?.(data.codeUnit as CodeUnit, id)} aria-label={`Open ${data.graphType === 'class_dependencies' ? 'class' : 'function'} ${data.label}`} title={data.address || data.label}>{label}</button>
      : data.graphType === 'member_references'
        ? <button type="button" className={className} onClick={() => data.onFocus?.(id)} aria-label={`Focus references for ${nodeCaption.toLowerCase()} ${data.label}`} title={data.label}>{label}</button>
        : <div className={className} role="img" aria-label={`${data.label}, ${nodeCaption.toLowerCase()}`} title={data.address || data.label}>{label}</div>}
    <Handle type="source" position={Position.Right} />
  </>
}

const nodeTypes = { functionGraphNode: FunctionNode }

function FitGraphWhenReady({ layoutKey, fitNodes, nodeCount }: { layoutKey: string; fitNodes: GraphFlowNode[]; nodeCount: number }) {
  const { fitView } = useReactFlow()

  useEffect(() => {
    if (nodeCount === 0) return

    // Wait for React Flow to measure both nodes and the below-the-fold canvas.
    // Fitting before either measurement completes can leave the graph tiny.
    let frame = 0
    let settledFrame = 0
    const timer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        settledFrame = window.requestAnimationFrame(() => {
          void fitView({
            nodes: fitNodes.length ? fitNodes : undefined,
            padding: fitNodes.length ? 0.3 : 0.2,
            minZoom: fitNodes.length ? (fitNodes.length > 32 ? 0.16 : 0.4) : (nodeCount > 32 ? 0.08 : 0.5),
            maxZoom: 1.15,
          })
        })
      })
    }, 180)

    return () => {
      window.clearTimeout(timer)
      window.cancelAnimationFrame(frame)
      window.cancelAnimationFrame(settledFrame)
    }
  }, [fitView, fitNodes, layoutKey, nodeCount])

  return null
}

export function WorkspaceCallGraphCanvas({ nodes, edges, focusKey, graphType = 'function_calls', onSelectNode }: {
  nodes: CallGraphRecord[]
  edges: CallGraphRelationship[]
  focusKey: string | null
  graphType?: 'function_calls' | 'class_dependencies' | 'member_references'
  onSelectNode: (node: CallGraphRecord) => void
}) {
  const [showEntireGraph, setShowEntireGraph] = useState(false)
  const graph = useMemo(() => layoutCallGraph(nodes, edges, focusKey, showEntireGraph), [nodes, edges, focusKey, showEntireGraph])
  const flowNodes = useMemo(() => graph.nodes.map((node): GraphFlowNode => ({
    ...node,
    data: {
      ...node.data,
      graphType,
      onOpen: (unit, graphKey) => {
        const record = nodes.find((candidate) => candidate.key === graphKey)
          || nodes.find((candidate) => candidate.codeUnit?.id === unit.id)
        if (record) onSelectNode(record)
      },
      onFocus: (graphKey) => {
        const record = nodes.find((candidate) => candidate.key === graphKey)
        if (record) onSelectNode(record)
      },
    },
  })), [graph.nodes, nodes, onSelectNode, graphType])
  const flowEdges = useMemo(() => graph.edges.map((edge) => ({
    ...edge,
    zIndex: 1,
    markerEnd: { type: MarkerType.ArrowClosed, color: '#82caff' },
    style: { ...edge.style, stroke: '#82caff', strokeWidth: 2.5 },
  })), [graph.edges])
  const fitNodes = useMemo(() => {
    if (!focusKey || showEntireGraph) return []
    const related = new Set([focusKey])
    for (const edge of graph.edges) {
      if (edge.source === focusKey) related.add(edge.target)
      if (edge.target === focusKey) related.add(edge.source)
    }
    return flowNodes.filter((node) => related.has(node.id))
  }, [flowNodes, focusKey, graph.edges, showEntireGraph])

  const graphLabel = graphType === 'class_dependencies'
    ? 'Program class dependency graph'
    : graphType === 'member_references' ? 'Program member reference graph' : 'Program function call graph'
  return <div className={styles.graphCanvas} role="region" aria-label={graphLabel}>
    <button
      type="button"
      className={styles.graphViewToggle}
      aria-pressed={showEntireGraph}
      onClick={() => setShowEntireGraph((show) => !show)}
    >
      {showEntireGraph ? 'Focus on one item' : `Show all ${nodes.length.toLocaleString()}`}
    </button>
    <ReactFlow
      colorMode="dark"
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      minZoom={0.08}
      maxZoom={1.75}
      nodesConnectable={false}
      nodesDraggable
      elementsSelectable
      defaultEdgeOptions={{ type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } }}
      aria-label={`Interactive ${graphLabel.toLowerCase()}`}
    >
      <Background color="#304057" gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(node) => {
        const data = node.data as GraphNodeData
        return data.isFocus ? '#41b88b' : data.codeUnit ? '#61aeea' : '#667085'
      }} />
      <FitGraphWhenReady fitNodes={fitNodes} nodeCount={flowNodes.length} layoutKey={`${graph.focusKey || ''}:${showEntireGraph}:${flowNodes.map((node) => node.id).join('|')}`} />
    </ReactFlow>
    {graph.hiddenNodeCount > 0 && <p className={styles.graphCanvasNote} aria-live="polite">
      Showing this item and its direct relationships. {graph.hiddenNodeCount.toLocaleString()} other items are outside this view; choose another code unit above to explore them.
    </p>}
  </div>
}

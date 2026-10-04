'use client'

import { useMemo } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { CodeUnit } from '@/lib/reamon/code-units'
import { layoutCallGraph, type CallGraphRecord, type CallGraphRelationship, type FunctionGraphNode, type FunctionGraphNodeData } from '@/lib/reamon/callgraph-layout'
import styles from './WorkspaceCodeVisualizer.module.css'

interface GraphNodeData extends FunctionGraphNodeData {
  onOpen?: (unit: CodeUnit) => void
  graphType?: 'function_calls' | 'class_dependencies'
}

type GraphFlowNode = FunctionGraphNode & { data: GraphNodeData }

function FunctionNode({ data, selected }: NodeProps<GraphFlowNode>) {
  const label = <>
    <strong>{data.label}</strong>
    {data.address && <small>{data.address}</small>}
    {!data.codeUnit && <small>External or not decompiled</small>}
  </>
  const className = `${styles.flowNode} ${data.isFocus ? styles.flowNodeFocus : ''} ${selected ? styles.flowNodeSelected : ''} ${!data.codeUnit ? styles.flowNodeExternal : ''}`

  return <>
    <Handle type="target" position={Position.Left} />
    {data.codeUnit
      ? <button type="button" className={className} onClick={() => data.onOpen?.(data.codeUnit as CodeUnit)} aria-label={`Open ${data.graphType === 'class_dependencies' ? 'class' : 'function'} ${data.label}`} title={data.address || data.label}>{label}</button>
      : <div className={className} role="img" aria-label={`${data.label}, external or not decompiled`} title={data.address || data.label}>{label}</div>}
    <Handle type="source" position={Position.Right} />
  </>
}

const nodeTypes = { functionGraphNode: FunctionNode }

export function WorkspaceCallGraphCanvas({ nodes, edges, focusKey, graphType = 'function_calls', onSelectNode }: {
  nodes: CallGraphRecord[]
  edges: CallGraphRelationship[]
  focusKey: string | null
  graphType?: 'function_calls' | 'class_dependencies'
  onSelectNode: (node: CallGraphRecord) => void
}) {
  const graph = useMemo(() => layoutCallGraph(nodes, edges, focusKey), [nodes, edges, focusKey])
  const flowNodes = useMemo(() => graph.nodes.map((node): GraphFlowNode => ({
    ...node,
    data: {
      ...node.data,
      graphType,
      onOpen: (unit) => {
        const record = nodes.find((candidate) => candidate.codeUnit?.id === unit.id)
        if (record) onSelectNode(record)
      },
    },
  })), [graph.nodes, nodes, onSelectNode, graphType])
  const flowEdges = useMemo(() => graph.edges.map((edge) => ({
    ...edge,
    markerEnd: { type: MarkerType.ArrowClosed, color: '#61aeea' },
  })), [graph.edges])

  const graphLabel = graphType === 'class_dependencies' ? 'Program class dependency graph' : 'Program function call graph'
  return <div className={styles.graphCanvas} role="region" aria-label={graphLabel}>
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.15 }}
      minZoom={0.08}
      maxZoom={1.75}
      nodesConnectable={false}
      nodesDraggable
      elementsSelectable
      defaultEdgeOptions={{ type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } }}
      aria-label={`Interactive ${graphType === 'class_dependencies' ? 'JADX class dependency graph' : 'Ghidra function call graph'}`}
    >
      <Background color="#304057" gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeColor={(node) => {
        const data = node.data as GraphNodeData
        return data.isFocus ? '#41b88b' : data.codeUnit ? '#61aeea' : '#667085'
      }} />
    </ReactFlow>
  </div>
}

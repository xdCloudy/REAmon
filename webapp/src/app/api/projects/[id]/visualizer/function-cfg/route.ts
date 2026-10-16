import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'

interface RouteParams { params: Promise<{ id: string }> }
const NO_STORE = { 'Cache-Control': 'private, no-store' }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
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
    const functionId = search.get('functionId')?.trim() || ''
    if (!taskId || taskId.length > 128 || !functionId || functionId.length > 128) {
      return NextResponse.json({ error: 'A valid function and analysis run are required' }, { status: 400, headers: NO_STORE })
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
      select: { id: true, artifactId: true },
    })
    if (!task?.artifactId) return NextResponse.json({ error: 'Decompilation run not found' }, { status: 404, headers: NO_STORE })

    const observation = await prisma.reamonObservation.findFirst({
      where: {
        id: functionId,
        projectId,
        taskId: task.id,
        artifactId: task.artifactId,
        source: 'reamon-unluac-rs',
        type: 'function',
        artifact: { is: selection.artifactWhere },
      },
      select: { label: true, attributes: true },
    })
    if (!observation) return NextResponse.json({ error: 'Lua prototype was not found in this run' }, { status: 404, headers: NO_STORE })

    const attributes = record(observation.attributes)
    let cfg: Record<string, unknown> | null = null
    if (typeof attributes?.controlFlowGraph === 'string') {
      if (attributes.controlFlowGraph.length <= 4_000) {
        try { cfg = record(JSON.parse(attributes.controlFlowGraph)) } catch { cfg = null }
      }
    }
    if (!cfg || !nonNegativeInteger(cfg.entryBlock) || !nonNegativeInteger(cfg.exitBlock)
      || !nonNegativeInteger(cfg.blockCount) || !nonNegativeInteger(cfg.edgeCount)
      || !Array.isArray(cfg.blocks) || cfg.blocks.length > 32
      || !Array.isArray(cfg.edges) || cfg.edges.length > 48) {
      return NextResponse.json({ error: 'This prototype has no valid control-flow summary' }, { status: 422, headers: NO_STORE })
    }

    const blocks = cfg.blocks.flatMap((value) => {
      if (!Array.isArray(value) || (value.length !== 4 && value.length !== 6) || !nonNegativeInteger(value[0]) || typeof value[1] !== 'string'
        || !nonNegativeInteger(value[2]) || !nonNegativeInteger(value[3])) return []
      const instructionSamples = value.length === 6 && Array.isArray(value[4])
        ? value[4].filter((line): line is string => typeof line === 'string').slice(0, 1).map((line) => line.slice(0, 100))
        : []
      const rawInstructionSamples = value.length === 6 && Array.isArray(value[5])
        ? value[5].filter((line): line is string => typeof line === 'string').slice(0, 1).map((line) => line.slice(0, 100))
        : []
      if (value.length === 6 && (!Array.isArray(value[4]) || !Array.isArray(value[5])
        || value[4].some((line) => typeof line !== 'string') || value[5].some((line) => typeof line !== 'string'))) return []
      return [{
        id: value[0],
        kind: value[1].slice(0, 40),
        instructionCount: value[2],
        rawInstructionCount: value[3],
        instructionSamples,
        rawInstructionSamples,
      }]
    })
    const edges = cfg.edges.flatMap((value) => {
      if (!Array.isArray(value) || value.length !== 3 || !nonNegativeInteger(value[0]) || !nonNegativeInteger(value[1])
        || typeof value[2] !== 'string') return []
      return [{ from: value[0], to: value[1], kind: value[2].slice(0, 40) }]
    })
    if (blocks.length !== cfg.blocks.length || edges.length !== cfg.edges.length) {
      return NextResponse.json({ error: 'This prototype has an incomplete control-flow summary' }, { status: 422, headers: NO_STORE })
    }

    return NextResponse.json({
      label: observation.label || 'Lua prototype',
      entryBlock: cfg.entryBlock,
      exitBlock: cfg.exitBlock,
      blockCount: cfg.blockCount,
      edgeCount: cfg.edgeCount,
      truncated: cfg.blockCount > blocks.length || cfg.edgeCount > edges.length,
      instructionSamplesTruncated: blocks.some((block) => block.instructionCount > block.instructionSamples.length
        || block.rawInstructionCount > block.rawInstructionSamples.length),
      blocks,
      edges,
    }, { headers: NO_STORE })
  } catch (error) {
    console.error('[reamon-visualizer-function-cfg] Error:', error)
    return NextResponse.json({ error: 'Unable to load this function control-flow graph' }, { status: 500, headers: NO_STORE })
  }
}

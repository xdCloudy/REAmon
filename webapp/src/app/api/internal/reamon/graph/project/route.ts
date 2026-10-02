import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { getGraphSession } from '@/app/api/graph/neo4j'
import prisma from '@/lib/prisma'
import { isInternalRequest } from '@/lib/session'
import { projectReamonObservations } from '@/lib/reamon/observation-projector'

export const runtime = 'nodejs'

interface ProjectionBody {
  projectId?: unknown
  projectionRunId?: unknown
  limit?: unknown
  batchSize?: unknown
  offset?: unknown
}

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
}

async function recordProjectionActivity(
  projectId: string,
  eventType: string,
  message: string,
  data: Record<string, unknown>,
) {
  try {
    await prisma.workspaceActivity.create({
      data: {
        projectId,
        actor: 'Projection worker',
        eventType,
        message,
        data: data as Prisma.InputJsonValue,
      },
    })
  } catch (error) {
    console.error('Failed to record REAmon projection activity:', error)
  }
}

async function createProjectionRun(projectionRunId: string, projectId: string, offset: number) {
  try {
    await prisma.reamonProjectionRun.upsert({
      where: { projectionRunId },
      create: { projectionRunId, projectId, offset },
      update: {},
    })
  } catch (error) {
    console.error('Failed to create REAmon projection run:', error)
  }
}

async function finishProjectionRun(
  projectionRunId: string,
  data: { status: string; offset?: number; selected?: number; nodes?: number; relationships?: number; truncated?: boolean; error?: string; completedAt?: Date },
) {
  try {
    await prisma.reamonProjectionRun.update({ where: { projectionRunId }, data })
  } catch (error) {
    console.error('Failed to update REAmon projection run:', error)
  }
}

export async function POST(request: NextRequest) {
  if (!isInternalRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let projectId: string | null = null
  let projectionRunId: string | null = null
  try {
    let body: ProjectionBody
    try {
      body = await request.json() as ProjectionBody
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('Request body must be an object')
    if (typeof body.projectId !== 'string' || !body.projectId.trim() || body.projectId.length > 128) return badRequest('projectId must be a bounded string')
    if (body.projectionRunId !== undefined && (typeof body.projectionRunId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(body.projectionRunId.trim()))) return badRequest('projectionRunId must be a bounded identifier')
    if (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isFinite(body.limit))) return badRequest('limit must be a number')
    if (body.batchSize !== undefined && (typeof body.batchSize !== 'number' || !Number.isFinite(body.batchSize))) return badRequest('batchSize must be a number')
    if (body.offset !== undefined && (typeof body.offset !== 'number' || !Number.isFinite(body.offset))) return badRequest('offset must be a number')

    projectId = body.projectId.trim()
    projectionRunId = typeof body.projectionRunId === 'string' ? body.projectionRunId.trim() : randomUUID()
    await createProjectionRun(projectionRunId, projectId, typeof body.offset === 'number' ? Math.min(1_000_000, Math.max(0, Math.floor(body.offset))) : 0)
    await recordProjectionActivity(projectId, 'analysis.graph_projection.started', `Started graph projection for ${projectId}`, {
      projectionRunId,
      limit: body.limit ?? null,
      batchSize: body.batchSize ?? null,
      offset: body.offset ?? 0,
    })

    const session = getGraphSession()
    try {
      const result = await projectReamonObservations(projectId, session, body.limit as number | undefined, body.batchSize as number | undefined, body.offset as number | undefined)
      await finishProjectionRun(projectionRunId, {
        status: 'COMPLETED',
        offset: result.offset,
        selected: result.selected,
        nodes: result.nodes,
        relationships: result.relationships,
        truncated: result.truncated,
        completedAt: new Date(),
      })
      await recordProjectionActivity(projectId, 'analysis.graph_projection.completed', `Projected ${result.nodes} nodes and ${result.relationships} relationships for ${projectId}`, {
        projectionRunId,
        ...result,
      })
      return NextResponse.json({ ...result, projectionRunId }, { headers: { 'Cache-Control': 'no-store' } })
    } finally {
      await session.close()
    }
  } catch (error) {
    if (projectId && projectionRunId) {
      await finishProjectionRun(projectionRunId, {
        status: 'FAILED',
        error: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown projection error',
        completedAt: new Date(),
      })
      await recordProjectionActivity(projectId, 'analysis.graph_projection.failed', `Graph projection failed for ${projectId}`, {
        projectionRunId,
        error: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown projection error',
      })
    }
    console.error('Failed to project REAmon observations:', error)
    return NextResponse.json({ error: 'Failed to project observations' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

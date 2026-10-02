import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { NextRequest, NextResponse } from 'next/server'
import { getGraphSession } from '@/app/api/graph/neo4j'
import prisma from '@/lib/prisma'
import { isInternalRequest } from '@/lib/session'
import { projectReamonObservations, reconcileProjectedGraph } from '@/lib/reamon/observation-projector'

export const runtime = 'nodejs'

interface ProjectionBody {
  projectId?: unknown
  projectionRunId?: unknown
  limit?: unknown
  batchSize?: unknown
  offset?: unknown
}

const PROJECTION_LEASE_MS = 5 * 60 * 1000

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

async function acquireProjectionLease(projectId: string, projectionRunId: string): Promise<boolean> {
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + PROJECTION_LEASE_MS)
  const rows = await prisma.$queryRaw<Array<{ project_id: string }>>(Prisma.sql`
    INSERT INTO "reamon_projection_leases" ("project_id", "projection_run_id", "lease_until", "created_at", "updated_at")
    VALUES (${projectId}, ${projectionRunId}, ${leaseUntil}, ${now}, ${now})
    ON CONFLICT ("project_id") DO UPDATE
      SET "projection_run_id" = EXCLUDED."projection_run_id",
          "lease_until" = EXCLUDED."lease_until",
          "updated_at" = EXCLUDED."updated_at"
      WHERE "reamon_projection_leases"."projection_run_id" = ${projectionRunId}
         OR "reamon_projection_leases"."lease_until" <= ${now}
    RETURNING "project_id"
  `)
  return rows.length === 1
}

async function releaseProjectionLease(projectId: string, projectionRunId: string) {
  try {
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "reamon_projection_leases"
      WHERE "project_id" = ${projectId} AND "projection_run_id" = ${projectionRunId}
    `)
  } catch (error) {
    console.error('Failed to release REAmon projection lease:', error)
  }
}

async function finishProjectionRun(
  projectionRunId: string,
  data: { status: string; offset?: number; selected?: number; nodes?: number; relationships?: number; truncated?: boolean; reconciled?: boolean; deletedNodes?: number; deletedRelationships?: number; error?: string; completedAt?: Date },
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
  let projectionRunCreated = false
  let projectionLeaseAcquired = false
  let projectionLeaseShouldRelease = false
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
    projectionLeaseAcquired = await acquireProjectionLease(projectId, projectionRunId)
    if (!projectionLeaseAcquired) {
      return NextResponse.json({ error: 'A graph projection is already running for this project' }, {
        status: 409,
        headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' },
      })
    }
    await createProjectionRun(projectionRunId, projectId, typeof body.offset === 'number' ? Math.min(1_000_000, Math.max(0, Math.floor(body.offset))) : 0)
    projectionRunCreated = true
    await recordProjectionActivity(projectId, 'analysis.graph_projection.started', `Started graph projection for ${projectId}`, {
      projectionRunId,
      limit: body.limit ?? null,
      batchSize: body.batchSize ?? null,
      offset: body.offset ?? 0,
    })

    const session = getGraphSession()
    try {
      const result = await projectReamonObservations(projectId, session, body.limit as number | undefined, body.batchSize as number | undefined, body.offset as number | undefined, projectionRunId)
      projectionLeaseShouldRelease = !result.truncated
      const reconciliation = result.truncated
        ? { reconciled: false, deletedNodes: 0, deletedRelationships: 0 }
        : { reconciled: true, ...(await reconcileProjectedGraph(session, projectId, projectionRunId)) }
      await finishProjectionRun(projectionRunId, {
        status: 'COMPLETED',
        offset: result.offset,
        selected: result.selected,
        nodes: result.nodes,
        relationships: result.relationships,
        truncated: result.truncated,
        ...reconciliation,
        completedAt: new Date(),
      })
      await recordProjectionActivity(projectId, 'analysis.graph_projection.completed', `Projected ${result.nodes} nodes and ${result.relationships} relationships for ${projectId}`, {
        projectionRunId,
        ...result,
        ...reconciliation,
      })
      return NextResponse.json({ ...result, ...reconciliation, projectionRunId }, { headers: { 'Cache-Control': 'no-store' } })
    } finally {
      await session.close()
    }
  } catch (error) {
    projectionLeaseShouldRelease = true
    if (projectId && projectionRunId && projectionRunCreated) {
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
  } finally {
    if (projectId && projectionRunId && projectionLeaseAcquired && projectionLeaseShouldRelease) await releaseProjectionLease(projectId, projectionRunId)
  }
}

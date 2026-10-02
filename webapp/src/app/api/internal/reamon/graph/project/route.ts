import { NextRequest, NextResponse } from 'next/server'
import { getGraphSession } from '@/app/api/graph/neo4j'
import { isInternalRequest } from '@/lib/session'
import { projectReamonObservations } from '@/lib/reamon/observation-projector'

export const runtime = 'nodejs'

interface ProjectionBody {
  projectId?: unknown
  limit?: unknown
  batchSize?: unknown
}

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
  if (!isInternalRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    let body: ProjectionBody
    try {
      body = await request.json() as ProjectionBody
    } catch {
      return badRequest('Request body must be valid JSON')
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('Request body must be an object')
    if (typeof body.projectId !== 'string' || !body.projectId.trim() || body.projectId.length > 128) return badRequest('projectId must be a bounded string')
    if (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isFinite(body.limit))) return badRequest('limit must be a number')
    if (body.batchSize !== undefined && (typeof body.batchSize !== 'number' || !Number.isFinite(body.batchSize))) return badRequest('batchSize must be a number')

    const session = getGraphSession()
    try {
      const result = await projectReamonObservations(body.projectId.trim(), session, body.limit as number | undefined, body.batchSize as number | undefined)
      return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
    } finally {
      await session.close()
    }
  } catch (error) {
    console.error('Failed to project REAmon observations:', error)
    return NextResponse.json({ error: 'Failed to project observations' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

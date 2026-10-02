import { NextRequest, NextResponse } from 'next/server'
import { isInternalRequest } from '@/lib/session'
import { recoverStaleAnalysisTasks } from '@/lib/reamon/task-control'
import { dispatchQueuedAnalysisTasks } from '@/lib/reamon/task-dispatcher'

export const runtime = 'nodejs'

interface DispatchBody {
  projectId?: unknown
  limit?: unknown
  recoverStale?: unknown
  staleAfterMinutes?: unknown
}

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
  if (!isInternalRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    let body: DispatchBody = {}
    try {
      const parsed = await request.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return badRequest('Request body must be an object')
      body = parsed as DispatchBody
    } catch {
      // Empty bodies use bounded defaults and global stale recovery.
    }

    let projectId: string | undefined
    if (body.projectId !== undefined) {
      if (typeof body.projectId !== 'string' || !body.projectId.trim() || body.projectId.length > 128) return badRequest('projectId must be a bounded string')
      projectId = body.projectId.trim()
    }

    let limit: number | undefined
    if (body.limit !== undefined) {
      if (typeof body.limit !== 'number' || !Number.isFinite(body.limit)) return badRequest('limit must be a number')
      limit = body.limit
    }

    let staleAfterMinutes: number | undefined
    if (body.staleAfterMinutes !== undefined) {
      if (typeof body.staleAfterMinutes !== 'number' || !Number.isFinite(body.staleAfterMinutes)) return badRequest('staleAfterMinutes must be a number')
      staleAfterMinutes = body.staleAfterMinutes
    }

    const recovered = body.recoverStale !== false
      ? await recoverStaleAnalysisTasks(projectId, staleAfterMinutes)
      : { recovered: 0, staleAfterMinutes: staleAfterMinutes ?? 30 }
    const dispatched = await dispatchQueuedAnalysisTasks({ projectId, limit })

    return NextResponse.json({
      recovered: recovered.recovered,
      staleAfterMinutes: recovered.staleAfterMinutes,
      requested: dispatched.requested,
      selected: dispatched.selected,
      results: dispatched.results.map((result) => ({ outcome: result.outcome, task: result.task })),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('Failed to dispatch REAmon analysis tasks:', error)
    return NextResponse.json({ error: 'Failed to dispatch analysis tasks' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

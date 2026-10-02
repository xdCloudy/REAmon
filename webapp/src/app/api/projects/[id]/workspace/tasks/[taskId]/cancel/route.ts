import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { cancelAnalysisTask } from '@/lib/reamon/task-control'

interface RouteParams { params: Promise<{ id: string; taskId: string }> }

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, taskId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const result = await cancelAnalysisTask(projectId, taskId)
    if (!result) return NextResponse.json({ error: 'Analysis task not found' }, { status: 404, headers: NO_STORE })
    if (result.outcome === 'SKIPPED') {
      return NextResponse.json({ error: 'Only queued or running tasks can be cancelled', task: result.task }, { status: 409, headers: NO_STORE })
    }
    return NextResponse.json({ cancelled: true, task: result.task }, { headers: NO_STORE })
  } catch (error) {
    console.error('Failed to cancel REAmon analysis task:', error)
    return NextResponse.json({ error: 'Failed to cancel analysis task' }, { status: 500, headers: NO_STORE })
  }
}

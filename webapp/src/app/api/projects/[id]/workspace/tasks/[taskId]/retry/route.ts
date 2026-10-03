import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { retryAnalysisTask } from '@/lib/reamon/task-control'

interface RouteParams { params: Promise<{ id: string; taskId: string }> }

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, taskId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const result = await retryAnalysisTask(projectId, taskId, effectiveUser.userId)
    if (!result) return NextResponse.json({ error: 'Analysis task not found' }, { status: 404, headers: NO_STORE })
    if (result.outcome === 'SKIPPED') {
      return NextResponse.json({ error: 'Only failed or cancelled tasks can be retried', task: result.task }, { status: 409, headers: NO_STORE })
    }
    return NextResponse.json({ retried: true, task: result.task }, { headers: NO_STORE })
  } catch (error) {
    console.error('Failed to retry REAmon analysis task:', error)
    return NextResponse.json({ error: 'Failed to retry analysis task' }, { status: 500, headers: NO_STORE })
  }
}

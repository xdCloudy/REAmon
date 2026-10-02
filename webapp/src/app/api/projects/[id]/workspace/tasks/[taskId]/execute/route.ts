import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { executeAnalysisTask } from '@/lib/reamon/task-executor'

interface RouteParams { params: Promise<{ id: string; taskId: string }> }

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, taskId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const result = await executeAnalysisTask(projectId, taskId)
    if (!result) return NextResponse.json({ error: 'Workspace task not found' }, { status: 404, headers: NO_STORE })
    if (result.outcome === 'SKIPPED' && result.task.status === 'RUNNING') {
      return NextResponse.json({ error: 'Task is already running', task: result.task }, { status: 409, headers: NO_STORE })
    }
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (error) {
    console.error('Failed to execute REAmon analysis task:', error)
    return NextResponse.json({ error: 'Failed to execute analysis task' }, { status: 500, headers: NO_STORE })
  }
}

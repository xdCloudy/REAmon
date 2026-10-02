import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { recoverStaleAnalysisTasks } from '@/lib/reamon/task-control'

interface RouteParams { params: Promise<{ id: string }> }
interface RecoveryBody { staleAfterMinutes?: unknown }

const NO_STORE = { 'Cache-Control': 'no-store' }

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400, headers: NO_STORE })
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    let body: RecoveryBody = {}
    try {
      const parsed = await request.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return badRequest('Request body must be an object')
      body = parsed as RecoveryBody
    } catch {
      // An empty body uses the safe default recovery window.
    }

    let staleAfterMinutes: number | undefined
    if (body.staleAfterMinutes !== undefined) {
      if (typeof body.staleAfterMinutes !== 'number' || !Number.isFinite(body.staleAfterMinutes)) {
        return badRequest('staleAfterMinutes must be a number')
      }
      staleAfterMinutes = body.staleAfterMinutes
    }

    const result = await recoverStaleAnalysisTasks(projectId, staleAfterMinutes)
    return NextResponse.json({ recovered: result.recovered, staleAfterMinutes: result.staleAfterMinutes }, { headers: NO_STORE })
  } catch (error) {
    console.error('Failed to recover stale REAmon analysis tasks:', error)
    return NextResponse.json({ error: 'Failed to recover stale analysis tasks' }, { status: 500, headers: NO_STORE })
  }
}

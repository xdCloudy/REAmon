import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { isFindingStatus, reviewFinding } from '@/lib/reamon/finding-review'

interface RouteParams { params: Promise<{ id: string; findingId: string }> }
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, findingId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    let body: { status?: unknown; note?: unknown } = {}
    try {
      const parsed = await request.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return NextResponse.json({ error: 'Request body must be an object' }, { status: 400, headers: NO_STORE })
      }
      body = parsed as typeof body
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400, headers: NO_STORE })
    }

    const status = typeof body.status === 'string' ? body.status.trim().toUpperCase() : ''
    if (!isFindingStatus(status)) return NextResponse.json({ error: 'Unsupported finding status' }, { status: 400, headers: NO_STORE })
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 4000)) {
      return NextResponse.json({ error: 'note must be a bounded string' }, { status: 400, headers: NO_STORE })
    }

    const result = await reviewFinding(projectId, findingId, status, effectiveUser.userId, body.note as string | undefined)
    if (!result) return NextResponse.json({ error: 'Finding not found' }, { status: 404, headers: NO_STORE })
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (error) {
    console.error('Failed to review REAmon finding:', error)
    return NextResponse.json({ error: 'Failed to review finding' }, { status: 500, headers: NO_STORE })
  }
}

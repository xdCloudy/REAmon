import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { decideTaskApproval, type ApprovalDecision } from '@/lib/reamon/task-approval'

interface RouteParams { params: Promise<{ id: string; approvalId: string }> }

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, approvalId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    let body: { decision?: unknown; reason?: unknown } = {}
    try {
      const parsed = await request.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return NextResponse.json({ error: 'Request body must be an object' }, { status: 400, headers: NO_STORE })
      }
      body = parsed as typeof body
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400, headers: NO_STORE })
    }

    const decision = typeof body.decision === 'string' ? body.decision.trim().toLowerCase() as ApprovalDecision : null
    if (decision !== 'approve' && decision !== 'reject') {
      return NextResponse.json({ error: 'decision must be approve or reject' }, { status: 400, headers: NO_STORE })
    }
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 4000)) {
      return NextResponse.json({ error: 'reason must be a bounded string' }, { status: 400, headers: NO_STORE })
    }

    const result = await decideTaskApproval(projectId, approvalId, decision, effectiveUser.userId, body.reason as string | undefined)
    if (!result) return NextResponse.json({ error: 'Task approval not found' }, { status: 404, headers: NO_STORE })
    if (result.outcome === 'SKIPPED') {
      return NextResponse.json({ error: 'Task approval has already been decided', approval: result.approval, task: result.task }, { status: 409, headers: NO_STORE })
    }
    return NextResponse.json({ decision, approval: result.approval, task: result.task }, { headers: NO_STORE })
  } catch (error) {
    console.error('Failed to decide REAmon task approval:', error)
    return NextResponse.json({ error: 'Failed to decide task approval' }, { status: 500, headers: NO_STORE })
  }
}

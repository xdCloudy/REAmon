import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { listTaskApprovals, type ApprovalStatus } from '@/lib/reamon/task-approval'

interface RouteParams { params: Promise<{ id: string }> }

const STATUSES = new Set<ApprovalStatus>(['PENDING', 'APPROVED', 'REJECTED'])
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const rawStatus = new URL(request.url).searchParams.get('status')
    const status = rawStatus ? rawStatus.toUpperCase() as ApprovalStatus : undefined
    if (status && !STATUSES.has(status)) {
      return NextResponse.json({ error: 'Unsupported approval status' }, { status: 400, headers: NO_STORE })
    }
    return NextResponse.json({ approvals: await listTaskApprovals(projectId, status) }, { headers: NO_STORE })
  } catch (error) {
    console.error('Failed to list REAmon task approvals:', error)
    return NextResponse.json({ error: 'Failed to list task approvals' }, { status: 500, headers: NO_STORE })
  }
}

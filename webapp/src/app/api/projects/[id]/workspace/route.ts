import { NextResponse } from 'next/server'
import { getWorkspaceSnapshot } from '@/lib/reamon/workspace'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, id)
    if (access instanceof NextResponse) return access

    const snapshot = await getWorkspaceSnapshot(id)
    if (!snapshot) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
    return NextResponse.json(snapshot, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to fetch REAmon workspace:', error)
    return NextResponse.json({ error: 'Failed to fetch workspace' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

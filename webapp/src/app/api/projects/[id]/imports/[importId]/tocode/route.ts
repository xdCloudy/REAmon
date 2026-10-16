import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { indexToCodeWorkspaceImport } from '@/lib/reamon/tocode-import'

interface RouteParams { params: Promise<{ id: string; importId: string }> }

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, importId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const result = await indexToCodeWorkspaceImport(projectId, importId)
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to index this ToCode export'
    const status = message === 'Completed workspace import not found' ? 404
      : message === 'This workspace import does not contain a ToCode export' || message === 'No valid ToCode functions were found in this workspace import' ? 400
        : 500
    if (status === 500) console.error('Failed to index ToCode workspace import:', error)
    return NextResponse.json({ error: status === 500 ? 'Unable to index this ToCode export' : message }, { status, headers: { 'Cache-Control': 'private, no-store' } })
  }
}

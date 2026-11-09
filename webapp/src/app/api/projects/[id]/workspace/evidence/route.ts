import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { listPersistedWorkspaceEvidence, WorkspaceEvidenceError } from '@/lib/reamon/workspace-evidence'

interface RouteParams { params: Promise<{ id: string }> }

function errorResponse(error: unknown) {
  if (error instanceof WorkspaceEvidenceError) {
    const status = error.code === 'not_found' ? 404
      : error.code === 'stale_evidence' || error.code === 'stale_snapshot' ? 409
        : error.code === 'cursor_unavailable' ? 503
          : error.code === 'too_large' ? 413
            : 400
    return NextResponse.json({ error: { code: error.code, message: error.message } }, {
      status,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
  console.error('Failed to query REAmon workspace evidence:', error)
  return NextResponse.json({ error: 'Failed to query workspace evidence' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const url = new URL(request.url)
    const artifactId = url.searchParams.get('artifactId') || undefined
    if (artifactId && !/^[A-Za-z0-9_-]{1,64}$/.test(artifactId)) {
      return NextResponse.json({ error: 'artifactId must be an alphanumeric id of at most 64 characters' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const rawLimit = url.searchParams.get('limit')
    const limit = rawLimit == null ? undefined : Number(rawLimit)
    if (limit != null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) {
      return NextResponse.json({ error: 'limit must be an integer between 1 and 50' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const cursor = url.searchParams.get('cursor') || undefined
    if (cursor && cursor.length > 512) {
      return NextResponse.json({ error: 'cursor must be at most 512 characters' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }

    const result = await listPersistedWorkspaceEvidence({ projectId, artifactId, limit, cursor })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}

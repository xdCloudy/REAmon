import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { readPersistedWorkspaceEvidence, WorkspaceEvidenceError } from '@/lib/reamon/workspace-evidence'

interface RouteParams { params: Promise<{ id: string; evidenceId: string }> }

function errorResponse(error: unknown) {
  if (error instanceof WorkspaceEvidenceError) {
    const status = error.code === 'not_found' ? 404
      : error.code === 'stale_evidence' ? 409
        : error.code === 'too_large' ? 413
          : 400
    return NextResponse.json({ error: { code: error.code, message: error.message } }, {
      status,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
  console.error('Failed to read REAmon workspace evidence:', error)
  return NextResponse.json({ error: 'Failed to read workspace evidence' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, evidenceId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const url = new URL(request.url)
    const rawOffsetBytes = url.searchParams.get('offsetBytes')
    const offsetBytes = rawOffsetBytes == null ? undefined : Number(rawOffsetBytes)
    if (offsetBytes != null && (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || offsetBytes > 32 * 1024 * 1024)) {
      return NextResponse.json({ error: 'offsetBytes must be an integer between 0 and 33554432' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const evidenceHash = url.searchParams.get('evidenceHash') || undefined

    const result = await readPersistedWorkspaceEvidence({ projectId, evidenceId, offsetBytes, evidenceHash })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}

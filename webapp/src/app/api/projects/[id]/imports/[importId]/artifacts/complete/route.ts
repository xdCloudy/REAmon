import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { commitStagedArtifact } from '@/lib/reamon/artifact-import-commit'
import { ARTIFACT_STORAGE_FULL_MESSAGE, isArtifactStorageFullError } from '@/lib/reamon/artifact-storage-errors'

interface RouteParams { params: Promise<{ id: string; importId: string }> }

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, importId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const body = await request.json() as { relativePath?: unknown; mimeType?: unknown }
    const relativePath = typeof body.relativePath === 'string' ? body.relativePath : ''
    const mimeType = typeof body.mimeType === 'string' && body.mimeType.length <= 255 ? body.mimeType : 'application/octet-stream'
    const result = await commitStagedArtifact({ projectId, importId, relativePath, providedMimeType: mimeType })
    return NextResponse.json({
      artifact: {
        id: result.artifact.id,
        relativePath,
        sizeBytes: result.artifact.sizeBytes,
        sha256: result.artifact.sha256,
        profile: result.profile,
        capabilities: result.capabilities,
      },
    }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('Failed to finalize REAmon artifact upload:', error)
    if (isArtifactStorageFullError(error)) {
      return NextResponse.json({ error: ARTIFACT_STORAGE_FULL_MESSAGE }, { status: 507, headers: { 'Cache-Control': 'no-store' } })
    }
    return NextResponse.json({ error: error instanceof Error ? error.message.slice(0, 800) : 'Failed to finalize uploaded artifact' }, {
      status: error instanceof Error && /not found/i.test(error.message) ? 404 : 400,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}

import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { InvalidWorkspacePathError, normalizeRelativePath } from '@/lib/reamon/paths'
import { commitArtifactFromPath } from '@/lib/reamon/artifact-import-commit'
import { ARTIFACT_STORAGE_FULL_MESSAGE, isArtifactStorageFullError } from '@/lib/reamon/artifact-storage-errors'
import { resolveServerSourceArtifact, SERVER_DIRECTORY_SOURCE_TYPE, ServerSourceError } from '@/lib/reamon/server-import'

interface RouteParams { params: Promise<{ id: string; importId: string }> }

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, importId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const workspaceImport = await prisma.workspaceImport.findFirst({
      where: { id: importId, projectId },
      select: { id: true, projectId: true, status: true, sourceType: true, metadata: true, manifest: true },
    })
    if (!workspaceImport) return NextResponse.json({ error: 'Import not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    if (workspaceImport.status === 'COMPLETED') {
      return NextResponse.json({ error: 'Import is already completed' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }

    if (workspaceImport.sourceType !== SERVER_DIRECTORY_SOURCE_TYPE) {
      return NextResponse.json({
        error: 'Browser uploads must use the resumable chunk upload endpoint',
      }, { status: 415, headers: { 'Cache-Control': 'no-store' } })
    }
    const relativePath = normalizeRelativePath(new URL(request.url).searchParams.get('relativePath') || '')
    if (request.body || Number(request.headers.get('content-length') || 0) > 0) {
      return NextResponse.json({ error: 'Server-mounted imports do not accept uploaded file bytes' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }

    const manifest = Array.isArray(workspaceImport.manifest) ? workspaceImport.manifest as Array<{ relativePath?: unknown; size?: unknown }> : []
    const manifestEntry = manifest.find((entry) => entry.relativePath === relativePath)
    if (!manifestEntry) {
      return NextResponse.json({ error: 'Path is not present in the import manifest' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const declaredSize = Number(manifestEntry.size)
    const metadata = workspaceImport.metadata && typeof workspaceImport.metadata === 'object' && !Array.isArray(workspaceImport.metadata)
      ? workspaceImport.metadata as Record<string, unknown>
      : {}
    if (typeof metadata.serverSourcePath !== 'string') {
      return NextResponse.json({ error: 'Server source metadata is missing' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
    const sourcePath = await resolveServerSourceArtifact(metadata.serverSourcePath, relativePath, Number.isSafeInteger(declaredSize) ? declaredSize : undefined)
    const imported = await commitArtifactFromPath({
      projectId, importId, relativePath, sourcePath,
      sourceType: SERVER_DIRECTORY_SOURCE_TYPE, cleanupSource: false,
    })
    return NextResponse.json({
      artifact: {
        id: imported.artifact.id, relativePath,
        sizeBytes: imported.artifact.sizeBytes, sha256: imported.artifact.sha256,
        profile: imported.profile, capabilities: imported.capabilities,
      },
    }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('Failed to import REAmon workspace artifact:', error)
    if (isArtifactStorageFullError(error)) {
      return NextResponse.json({ error: ARTIFACT_STORAGE_FULL_MESSAGE }, { status: 507, headers: { 'Cache-Control': 'no-store' } })
    }
    const message = error instanceof Error ? error.message : 'Failed to upload artifact'
    const expectedError = error instanceof ServerSourceError || error instanceof InvalidWorkspacePathError
    const status = error instanceof ServerSourceError ? error.status : error instanceof InvalidWorkspacePathError ? 400 : 500
    return NextResponse.json({ error: expectedError ? message : 'Failed to upload artifact' }, { status, headers: { 'Cache-Control': 'no-store' } })
  }
}

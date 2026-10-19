import { createHash, randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { resolveCapabilities } from '@/lib/reamon/capabilities'
import { isLogicalTargetCandidate } from '@/lib/reamon/inventory'
import { InvalidWorkspacePathError, parentPathOf, normalizeRelativePath } from '@/lib/reamon/paths'
import { profileArtifact } from '@/lib/reamon/profiler'
import { commitArtifactFromPath } from '@/lib/reamon/artifact-import-commit'
import { resolveServerSourceArtifact, SERVER_DIRECTORY_SOURCE_TYPE, ServerSourceError } from '@/lib/reamon/server-import'

interface RouteParams { params: Promise<{ id: string; importId: string }> }

class WorkspaceImportClosedError extends Error {
  constructor() {
    super('Import is no longer accepting artifacts')
    this.name = 'WorkspaceImportClosedError'
  }
}

function artifactRoot(): string {
  return path.resolve(process.env.REAMON_ARTIFACTS_PATH || path.join(process.cwd(), 'data', 'reamon-artifacts'))
}

function basenameOf(relativePath: string): string {
  return relativePath.split('/').pop() || relativePath
}

function storagePathFor(projectId: string, importId: string, artifactId: string, sha256: string): { relative: string; absolute: string } {
  // Keep each upload immutable so a failed retry cannot overwrite live bytes.
  return confinedStoragePath(path.join(projectId, importId, artifactId, sha256))
}

function confinedStoragePath(relative: string): { relative: string; absolute: string } {
  const root = artifactRoot()
  const absolute = path.resolve(root, relative)
  const confined = path.relative(root, absolute)
  if (!confined || confined.startsWith('..') || path.isAbsolute(confined)) throw new Error('Invalid artifact storage path')
  return { relative, absolute }
}

export async function POST(request: Request, { params }: RouteParams) {
  let writtenPath = ''
  let databaseCommitted = false
  try {
    const { id: projectId, importId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    let form: FormData
    try {
      form = await request.formData()
    } catch (error) {
      console.warn('Could not parse REAmon workspace artifact multipart body:', error)
      return NextResponse.json({
        error: 'Could not parse the uploaded file. Retry using the resumable chunked workspace import.',
      }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const fileValue = form.get('file')
    const workspaceImport = await prisma.workspaceImport.findFirst({
      where: { id: importId, projectId },
      select: { id: true, projectId: true, rootTargetId: true, status: true, sourceType: true, metadata: true, manifest: true },
    })
    if (!workspaceImport) return NextResponse.json({ error: 'Import not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    // CANCELLED is a resumable client-side pause. A retry explicitly reopens
    // it by accepting its next artifact; completed snapshots stay immutable.
    if (workspaceImport.status === 'COMPLETED') {
      return NextResponse.json({ error: `Import is already ${workspaceImport.status.toLowerCase()}` }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }

    const isServerSource = workspaceImport.sourceType === SERVER_DIRECTORY_SOURCE_TYPE
    if (!isServerSource && !(fileValue instanceof File)) {
      return NextResponse.json({ error: 'A file is required' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    if (isServerSource && fileValue !== null) {
      return NextResponse.json({ error: 'Server-mounted imports do not accept uploaded files' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }

    const relativePath = normalizeRelativePath(String(form.get('relativePath') || (fileValue instanceof File ? fileValue.name : '')))

    const manifest = Array.isArray(workspaceImport.manifest) ? workspaceImport.manifest as Array<{ relativePath?: unknown; size?: unknown }> : []
    const manifestEntry = manifest.find((entry) => entry.relativePath === relativePath)
    if (!manifestEntry) {
      return NextResponse.json({ error: 'Path is not present in the import manifest' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const declaredSize = Number(manifestEntry.size)

    if (isServerSource) {
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
    }

    let bytes: Uint8Array
    let mimeType = 'application/octet-stream'
    const file = fileValue as File
    if (Number.isSafeInteger(declaredSize) && declaredSize !== file.size) {
      return NextResponse.json({ error: `Uploaded size does not match the manifest for ${relativePath}` }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    bytes = new Uint8Array(await file.arrayBuffer())
    mimeType = file.type
    if (Number.isSafeInteger(declaredSize) && declaredSize !== bytes.byteLength) {
      return NextResponse.json({ error: `Imported size does not match the manifest for ${relativePath}` }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const originalName = basenameOf(relativePath)
    const profile = profileArtifact(bytes, relativePath, mimeType)
    const capabilities = resolveCapabilities(profile)
    const profileJson = profile as unknown as Prisma.InputJsonValue
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    // Always write a fresh immutable candidate before entering the transaction.
    // The import row is then locked inside the transaction before looking up
    // the logical path, so concurrent retries cannot create duplicate rows or
    // overwrite bytes that a previous request still needs.
    const candidateArtifactId = randomUUID()
    const storage = storagePathFor(projectId, importId, candidateArtifactId, sha256)
    writtenPath = storage.absolute
    await mkdir(path.dirname(storage.absolute), { recursive: true })
    await writeFile(storage.absolute, bytes)

    const result = await prisma.$transaction(async (tx) => {
      // Updating the import row first serializes same-import uploads on
      // PostgreSQL's row lock. The path lookup must happen after that lock.
      const lockedImport = await tx.workspaceImport.updateMany({
        where: { id: importId, status: { notIn: ['COMPLETED'] } },
        data: { status: 'UPLOADING' },
      })
      if (lockedImport.count !== 1) throw new WorkspaceImportClosedError()
      const existing = await tx.artifact.findFirst({
        where: { projectId, importId, relativePath },
        select: { id: true, storagePath: true, targetId: true },
      })
      let targetId = existing?.targetId || workspaceImport.rootTargetId
      if (isLogicalTargetCandidate({ relativePath, sizeBytes: bytes.byteLength, profile }) && !existing?.targetId) {
        const target = await tx.target.create({
          data: {
            projectId,
            parentTargetId: workspaceImport.rootTargetId,
            name: originalName,
            targetType: profile.targetType === 'UNKNOWN' ? 'FILE' : profile.targetType,
            locator: `artifact:${relativePath}`,
            status: 'IDENTIFIED',
            profile: profileJson,
          },
        })
        targetId = target.id
      }

      const artifact = existing
        ? await tx.artifact.update({
            where: { id: existing.id },
            data: {
              targetId,
              name: originalName,
              originalName,
              relativePath,
              parentPath: parentPathOf(relativePath),
              storagePath: storage.relative,
              sha256,
              sizeBytes: bytes.byteLength,
              mimeType: profile.mimeType,
              extension: profile.extension,
              status: 'IDENTIFIED',
              profile: profileJson,
              capabilities: capabilities.flatMap((match) => match.capabilities),
            },
          })
        : await tx.artifact.create({
            data: {
              id: candidateArtifactId,
              projectId,
              importId,
              targetId,
              name: originalName,
              originalName,
              relativePath,
              parentPath: parentPathOf(relativePath),
              storagePath: storage.relative,
              sha256,
              sizeBytes: bytes.byteLength,
              mimeType: profile.mimeType,
              extension: profile.extension,
              status: 'IDENTIFIED',
              profile: profileJson,
              capabilities: capabilities.flatMap((match) => match.capabilities),
            },
          })

      await tx.evidence.deleteMany({ where: { artifactId: artifact.id, kind: 'profile', source: 'reamon-artifact-profiler' } })
      await tx.evidence.create({
        data: {
          projectId,
          targetId,
          artifactId: artifact.id,
          kind: 'profile',
          summary: `Profiler identified ${profile.format} at ${relativePath}`,
          source: 'reamon-artifact-profiler',
          data: profileJson,
        },
      })
      await tx.workspaceActivity.create({
        data: {
          projectId,
          actor: 'Profiler',
          eventType: 'artifact.profiled',
          message: `Profiled ${relativePath} as ${profile.format}`,
          data: { importId, artifactId: artifact.id, targetId, relativePath, format: profile.format },
        },
      })

      if (!existing) {
        await tx.workspaceImport.update({
          where: { id: importId },
          data: {
            status: 'UPLOADING',
            completedFiles: { increment: 1 },
            uploadedBytes: { increment: BigInt(bytes.byteLength) },
          },
        })
      }
      return { artifact, previousStoragePath: existing?.storagePath || null, reused: Boolean(existing) }
    })
    databaseCommitted = true
    if (result.previousStoragePath && result.previousStoragePath !== storage.relative) {
      try {
        await unlink(confinedStoragePath(result.previousStoragePath).absolute)
      } catch (error) {
        console.warn('Failed to remove replaced REAmon artifact bytes:', error)
      }
    }

    return NextResponse.json({
      artifact: {
        id: result.artifact.id,
        relativePath,
        sizeBytes: Number(result.artifact.sizeBytes),
        sha256: result.artifact.sha256,
        profile,
        capabilities,
      },
    }, { status: result.reused ? 200 : 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (writtenPath && !databaseCommitted) await unlink(writtenPath).catch(() => {})
    console.error('Failed to import REAmon workspace artifact:', error)
    const message = error instanceof Error ? error.message : 'Failed to upload artifact'
    const serverSourceError = error instanceof ServerSourceError
    const invalidInput = error instanceof InvalidWorkspacePathError
    const closedImport = error instanceof WorkspaceImportClosedError
    const status = serverSourceError ? error.status : invalidInput ? 400 : closedImport ? 409 : 500
    return NextResponse.json({ error: serverSourceError || invalidInput || closedImport ? message : 'Failed to upload artifact' }, { status, headers: { 'Cache-Control': 'no-store' } })
  }
}

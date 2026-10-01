import { createHash, randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { resolveCapabilities } from '@/lib/reamon/capabilities'
import { isLogicalTargetCandidate } from '@/lib/reamon/inventory'
import { parentPathOf, normalizeRelativePath } from '@/lib/reamon/paths'
import { profileArtifact } from '@/lib/reamon/profiler'

interface RouteParams { params: Promise<{ id: string; importId: string }> }

const DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

function maxArtifactBytes(): number {
  const value = Number.parseInt(process.env.REAMON_MAX_ARTIFACT_BYTES || '', 10)
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_MAX_ARTIFACT_BYTES
}

function artifactRoot(): string {
  return path.resolve(process.env.REAMON_ARTIFACTS_PATH || path.join(process.cwd(), 'data', 'reamon-artifacts'))
}

function basenameOf(relativePath: string): string {
  return relativePath.split('/').pop() || relativePath
}

function storagePathFor(projectId: string, importId: string, artifactId: string): { relative: string; absolute: string } {
  return confinedStoragePath(path.join(projectId, importId, artifactId))
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
  let existingArtifact = false
  try {
    const { id: projectId, importId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const form = await request.formData()
    const fileValue = form.get('file')
    if (!(fileValue instanceof File)) return NextResponse.json({ error: 'A file is required' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    if (fileValue.size > maxArtifactBytes()) {
      return NextResponse.json({ error: `File exceeds the ${Math.round(maxArtifactBytes() / 1024 / 1024)} MiB limit` }, { status: 413, headers: { 'Cache-Control': 'no-store' } })
    }

    const relativePath = normalizeRelativePath(String(form.get('relativePath') || fileValue.name || ''))
    const workspaceImport = await prisma.workspaceImport.findFirst({
      where: { id: importId, projectId },
      select: { id: true, projectId: true, rootTargetId: true, status: true, manifest: true },
    })
    if (!workspaceImport) return NextResponse.json({ error: 'Import not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    if (workspaceImport.status === 'COMPLETED' || workspaceImport.status === 'CANCELLED') {
      return NextResponse.json({ error: `Import is already ${workspaceImport.status.toLowerCase()}` }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }

    const manifest = Array.isArray(workspaceImport.manifest) ? workspaceImport.manifest as Array<{ relativePath?: unknown; size?: unknown }> : []
    const manifestEntry = manifest.find((entry) => entry.relativePath === relativePath)
    if (!manifestEntry) {
      return NextResponse.json({ error: 'Path is not present in the import manifest' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const declaredSize = Number(manifestEntry.size)
    if (Number.isSafeInteger(declaredSize) && declaredSize !== fileValue.size) {
      return NextResponse.json({ error: `Uploaded size does not match the manifest for ${relativePath}` }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }

    const bytes = new Uint8Array(await fileValue.arrayBuffer())
    const originalName = basenameOf(relativePath)
    const profile = profileArtifact(bytes, relativePath, fileValue.type)
    const capabilities = resolveCapabilities(profile)
    const profileJson = profile as unknown as Prisma.InputJsonValue
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const existing = await prisma.artifact.findFirst({
      where: { projectId, importId, relativePath },
      select: { id: true, storagePath: true, targetId: true, sizeBytes: true },
    })
    existingArtifact = Boolean(existing)
    const artifactId = existing?.id || randomUUID()
    const storage = existing?.storagePath
      ? confinedStoragePath(existing.storagePath)
      : storagePathFor(projectId, importId, artifactId)
    writtenPath = storage.absolute
    await mkdir(path.dirname(storage.absolute), { recursive: true })
    await writeFile(storage.absolute, bytes)

    const result = await prisma.$transaction(async (tx) => {
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
              id: artifactId,
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
      } else {
        await tx.workspaceImport.update({ where: { id: importId }, data: { status: 'UPLOADING' } })
      }
      return artifact
    })
    databaseCommitted = true

    return NextResponse.json({
      artifact: {
        id: result.id,
        relativePath,
        sizeBytes: result.sizeBytes,
        sha256: result.sha256,
        profile,
        capabilities,
      },
    }, { status: existing ? 200 : 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (writtenPath && !databaseCommitted && !existingArtifact) await unlink(writtenPath).catch(() => {})
    console.error('Failed to import REAmon workspace artifact:', error)
    const message = error instanceof Error ? error.message : 'Failed to upload artifact'
    return NextResponse.json({ error: /path|manifest|file|import|limit|absolute|invalid/i.test(message) ? message : 'Failed to upload artifact' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
}

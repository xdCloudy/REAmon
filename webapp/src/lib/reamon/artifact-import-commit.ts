import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, open, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { resolveCapabilities } from './capabilities'
import { isLogicalTargetCandidate } from './inventory'
import { parentPathOf, normalizeRelativePath } from './paths'
import { profileArtifact } from './profiler'

const PROFILE_SAMPLE_BYTES = 4 * 1024 * 1024

export function artifactRoot(): string {
  return path.resolve(process.env.REAMON_ARTIFACTS_PATH || path.join(process.cwd(), 'data', 'reamon-artifacts'))
}

export function stagedArtifactPath(projectId: string, importId: string, relativePath: string): string {
  const key = createHash('sha256').update(relativePath).digest('hex')
  return path.join(artifactRoot(), '.uploads', projectId, importId, `${key}.part`)
}

export async function receiveArtifactChunk(input: {
  projectId: string
  importId: string
  relativePath: string
  offset: number
  totalSize: number
  bytes: Uint8Array
}): Promise<number> {
  const relativePath = normalizeRelativePath(input.relativePath)
  const destination = stagedArtifactPath(input.projectId, input.importId, relativePath)
  await mkdir(path.dirname(destination), { recursive: true })
  let handle
  try {
    handle = await open(destination, 'r+')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    handle = await open(destination, 'wx+')
  }
  try {
    const currentSize = (await handle.stat()).size
    const chunkEnd = input.offset + input.bytes.byteLength
    if (chunkEnd > input.totalSize) throw new Error('Chunk exceeds the declared artifact size')
    if (input.offset < currentSize) {
      // A client may need to retry after the process or connection stopped
      // between a partial disk write and the response. Verify the persisted
      // overlap, then append only the missing tail. Fully repeated chunks are
      // idempotent; conflicting bytes remain a hard error.
      const overlap = Math.min(currentSize - input.offset, input.bytes.byteLength)
      const prior = Buffer.alloc(overlap)
      const { bytesRead } = await handle.read(prior, 0, overlap, input.offset)
      if (bytesRead !== overlap || !prior.equals(Buffer.from(input.bytes.subarray(0, overlap)))) {
        throw new Error('Retried upload chunk conflicts with bytes already received')
      }
      if (overlap === input.bytes.byteLength) return currentSize
      const tail = input.bytes.subarray(overlap)
      let written = 0
      while (written < tail.byteLength) {
        const result = await handle.write(tail, written, tail.byteLength - written, currentSize + written)
        if (result.bytesWritten <= 0) throw new Error('Could not persist the uploaded chunk')
        written += result.bytesWritten
      }
      return currentSize + written
    }
    if (input.offset !== currentSize) throw new Error('Upload chunk offset does not match the received file bytes')
    let written = 0
    while (written < input.bytes.byteLength) {
      const result = await handle.write(input.bytes, written, input.bytes.byteLength - written, input.offset + written)
      if (result.bytesWritten <= 0) throw new Error('Could not persist the uploaded chunk')
      written += result.bytesWritten
    }
    return input.offset + written
  } finally {
    await handle.close()
  }
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

async function sampleFile(filePath: string, size: number): Promise<Uint8Array> {
  const length = Math.min(size, PROFILE_SAMPLE_BYTES)
  const bytes = Buffer.alloc(length)
  const handle = await open(filePath, 'r')
  try {
    let read = 0
    while (read < length) {
      const result = await handle.read(bytes, read, length - read, read)
      if (!result.bytesRead) break
      read += result.bytesRead
    }
    return new Uint8Array(bytes.subarray(0, read))
  } finally {
    await handle.close()
  }
}

function confinedStoragePath(relative: string): { relative: string; absolute: string } {
  const root = artifactRoot()
  const absolute = path.resolve(root, relative)
  const confined = path.relative(root, absolute)
  if (!confined || confined.startsWith('..') || path.isAbsolute(confined)) throw new Error('Invalid artifact storage path')
  return { relative, absolute }
}

export async function commitArtifactFromPath(input: {
  projectId: string
  importId: string
  relativePath: string
  sourcePath: string
  sourceType: 'BROWSER_DIRECTORY' | 'SERVER_DIRECTORY'
  cleanupSource: boolean
  providedMimeType?: string
}): Promise<{ artifact: { id: string; sizeBytes: number; sha256: string }; profile: ReturnType<typeof profileArtifact>; capabilities: ReturnType<typeof resolveCapabilities> }> {
  const relativePath = normalizeRelativePath(input.relativePath)
  const workspaceImport = await prisma.workspaceImport.findFirst({
    where: { id: input.importId, projectId: input.projectId },
    select: { id: true, rootTargetId: true, status: true, sourceType: true, manifest: true },
  })
  if (!workspaceImport) throw new Error('Import not found')
  if (workspaceImport.sourceType !== input.sourceType) throw new Error('Upload source does not match the import')
  if (workspaceImport.status === 'COMPLETED') throw new Error('Import is already completed')
  if (workspaceImport.status === 'CANCELLED' || workspaceImport.status === 'CANCELLING') throw new Error('Import is no longer accepting artifacts')
  const manifest = Array.isArray(workspaceImport.manifest) ? workspaceImport.manifest as Array<{ relativePath?: unknown; size?: unknown }> : []
  const manifestEntry = manifest.find((entry) => entry.relativePath === relativePath)
  const expectedSize = Number(manifestEntry?.size)
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error('Path is not present in the import manifest')

  const stagedPath = input.sourcePath
  if (input.cleanupSource) {
    try {
      await stat(stagedPath)
    } catch {
      if (expectedSize !== 0) throw new Error('Artifact upload is incomplete')
      await mkdir(path.dirname(stagedPath), { recursive: true })
      const empty = await open(stagedPath, 'wx')
      await empty.close()
    }
  }
  const stagedStat = await stat(stagedPath)
  if (!stagedStat.isFile() || stagedStat.size !== expectedSize) throw new Error(`Artifact upload is incomplete (${stagedStat.size} of ${expectedSize} bytes received)`)
  if (!Number.isSafeInteger(stagedStat.size)) throw new Error('Artifact is too large for the current file index')

  const sample = await sampleFile(stagedPath, stagedStat.size)
  const profile = profileArtifact(sample, relativePath, input.providedMimeType || 'application/octet-stream', stagedStat.size)
  const capabilities = resolveCapabilities(profile)
  const profileJson = profile as unknown as Prisma.InputJsonValue
  const sha256 = await sha256File(stagedPath)
  const candidateArtifactId = randomUUID()
  const storage = confinedStoragePath(path.join(input.projectId, input.importId, candidateArtifactId, sha256))
  let databaseCommitted = false
  await mkdir(path.dirname(storage.absolute), { recursive: true })
  await copyFile(stagedPath, storage.absolute)

  try {
    const result = await prisma.$transaction(async (tx) => {
      const lockedImport = await tx.workspaceImport.updateMany({
        where: { id: input.importId, status: { notIn: ['COMPLETED', 'CANCELLED', 'CANCELLING'] } },
        data: { status: 'UPLOADING' },
      })
      if (lockedImport.count !== 1) throw new Error('Import is no longer accepting artifacts')
      const existing = await tx.artifact.findFirst({
        where: { projectId: input.projectId, importId: input.importId, relativePath },
        select: { id: true, storagePath: true, targetId: true },
      })
      const originalName = relativePath.split('/').pop() || relativePath
      let targetId = existing?.targetId || workspaceImport.rootTargetId
      if (isLogicalTargetCandidate({ relativePath, sizeBytes: stagedStat.size, profile }) && !existing?.targetId) {
        const target = await tx.target.create({
          data: {
            projectId: input.projectId,
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
              targetId, name: originalName, originalName, relativePath,
              parentPath: parentPathOf(relativePath), storagePath: storage.relative,
              sha256, sizeBytes: stagedStat.size, mimeType: profile.mimeType,
              extension: profile.extension, status: 'IDENTIFIED', profile: profileJson,
              capabilities: capabilities.flatMap((match) => match.capabilities),
            },
          })
        : await tx.artifact.create({
            data: {
              id: candidateArtifactId, projectId: input.projectId, importId: input.importId,
              targetId, name: originalName, originalName, relativePath,
              parentPath: parentPathOf(relativePath), storagePath: storage.relative,
              sha256, sizeBytes: stagedStat.size, mimeType: profile.mimeType,
              extension: profile.extension, status: 'IDENTIFIED', profile: profileJson,
              capabilities: capabilities.flatMap((match) => match.capabilities),
            },
          })
      await tx.evidence.deleteMany({ where: { artifactId: artifact.id, kind: 'profile', source: 'reamon-artifact-profiler' } })
      await tx.evidence.create({
        data: {
          projectId: input.projectId, targetId, artifactId: artifact.id, kind: 'profile',
          summary: `Profiler identified ${profile.format} at ${relativePath}`,
          source: 'reamon-artifact-profiler', data: profileJson,
        },
      })
      await tx.workspaceActivity.create({
        data: {
          projectId: input.projectId, actor: 'Profiler', eventType: 'artifact.profiled',
          message: `Profiled ${relativePath} as ${profile.format}`,
          data: { importId: input.importId, artifactId: artifact.id, targetId, relativePath, format: profile.format },
        },
      })
      if (!existing) {
        await tx.workspaceImport.update({
          where: { id: input.importId },
          data: {
            status: 'UPLOADING', completedFiles: { increment: 1 },
            uploadedBytes: { increment: BigInt(stagedStat.size) },
          },
        })
      }
      return { artifact, previousStoragePath: existing?.storagePath || null }
    })
    databaseCommitted = true
    if (input.cleanupSource) await unlink(stagedPath).catch(() => {})
    if (result.previousStoragePath && result.previousStoragePath !== storage.relative) {
      await unlink(confinedStoragePath(result.previousStoragePath).absolute).catch(() => {})
    }
    return {
      artifact: { id: result.artifact.id, sizeBytes: Number(result.artifact.sizeBytes), sha256: result.artifact.sha256 },
      profile,
      capabilities,
    }
  } finally {
    if (!databaseCommitted) await unlink(storage.absolute).catch(() => {})
  }
}

export function commitStagedArtifact(input: { projectId: string; importId: string; relativePath: string; providedMimeType?: string }) {
  return commitArtifactFromPath({
    ...input,
    sourcePath: stagedArtifactPath(input.projectId, input.importId, input.relativePath),
    sourceType: 'BROWSER_DIRECTORY',
    cleanupSource: true,
    providedMimeType: input.providedMimeType,
  })
}

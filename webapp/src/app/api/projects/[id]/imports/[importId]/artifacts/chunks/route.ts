import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { truncate } from 'node:fs/promises'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { normalizeRelativePath } from '@/lib/reamon/paths'
import { receiveArtifactChunk, stagedArtifactPath } from '@/lib/reamon/artifact-import-commit'

interface RouteParams { params: Promise<{ id: string; importId: string }> }
const MAX_CHUNK_BYTES = 16 * 1024 * 1024

export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, importId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const relativePath = normalizeRelativePath(new URL(request.url).searchParams.get('relativePath') || '')
    const offset = Number(request.headers.get('x-reamon-upload-offset'))
    const totalSize = Number(request.headers.get('x-reamon-upload-size'))
    const contentLengthHeader = request.headers.get('content-length')
    const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(totalSize) || totalSize < 0
      || (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_CHUNK_BYTES))) {
      return NextResponse.json({ error: 'Invalid upload chunk metadata' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const workspaceImport = await prisma.workspaceImport.findFirst({
      where: { id: importId, projectId },
      select: { status: true, sourceType: true, manifest: true },
    })
    if (!workspaceImport) return NextResponse.json({ error: 'Import not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    if (workspaceImport.status === 'COMPLETED') return NextResponse.json({ error: 'Import is already completed' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    if (workspaceImport.sourceType !== 'BROWSER_DIRECTORY') return NextResponse.json({ error: 'Chunk uploads require a browser import' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    const manifest = Array.isArray(workspaceImport.manifest) ? workspaceImport.manifest as Array<{ relativePath?: unknown; size?: unknown }> : []
    const entry = manifest.find((candidate) => candidate.relativePath === relativePath)
    if (!entry || Number(entry.size) !== totalSize) return NextResponse.json({ error: 'File size or path does not match the import manifest' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    const activity = await prisma.workspaceImport.updateMany({
      where: {
        id: importId,
        projectId,
        sourceType: 'BROWSER_DIRECTORY',
        status: { notIn: ['COMPLETED', 'CANCELLED', 'CANCELLING', 'FINALIZING'] },
      },
      data: { updatedAt: new Date() },
    })
    if (activity.count !== 1) return NextResponse.json({ error: 'Import is no longer accepting artifacts' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    if (!request.body) {
      return NextResponse.json({ error: 'Upload chunk body is required' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let byteLength = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        byteLength += value.byteLength
        if (byteLength > MAX_CHUNK_BYTES) {
          await reader.cancel()
          return NextResponse.json({ error: 'Upload chunk exceeds the allowed request size' }, { status: 413, headers: { 'Cache-Control': 'no-store' } })
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    if (byteLength <= 0 || (contentLength !== null && byteLength !== contentLength)) {
      return NextResponse.json({ error: 'Upload chunk length did not match the allowed request size' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    if (offset + byteLength > totalSize) return NextResponse.json({ error: 'Chunk exceeds the declared artifact size' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    const bytes = new Uint8Array(byteLength)
    let position = 0
    for (const chunk of chunks) {
      bytes.set(chunk, position)
      position += chunk.byteLength
    }
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${importId}), hashtext(${relativePath}))`)
      const accepted = await tx.workspaceImport.updateMany({
        where: {
          id: importId,
          projectId,
          sourceType: 'BROWSER_DIRECTORY',
          status: { notIn: ['COMPLETED', 'CANCELLED', 'CANCELLING', 'FINALIZING'] },
        },
        data: { updatedAt: new Date() },
      })
      if (accepted.count !== 1) throw new Error('Import is no longer accepting artifacts')
      const committed = await tx.artifact.findFirst({
        where: { projectId, importId, relativePath },
        select: { id: true },
      })
      if (committed) return { receivedBytes: totalSize, addedBytes: 0 }
      const received = await receiveArtifactChunk({ projectId, importId, relativePath, offset, totalSize, bytes })
      if (received.addedBytes > 0) {
        try {
          await tx.workspaceImport.update({
            where: { id: importId },
            data: { uploadedBytes: { increment: BigInt(received.addedBytes) } },
          })
        } catch (error) {
          await truncate(stagedArtifactPath(projectId, importId, relativePath), received.previousBytes).catch(() => {})
          throw error
        }
      }
      return received
    })
    return NextResponse.json({ receivedBytes: result.receivedBytes }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('Failed to receive REAmon artifact chunk:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message.slice(0, 500) : 'Failed to receive upload chunk' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
}

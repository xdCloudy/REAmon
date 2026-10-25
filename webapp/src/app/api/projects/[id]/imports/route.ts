import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { mkdir } from 'node:fs/promises'
import { artifactRoot, getArtifactVolumeCapacity } from '@/lib/reamon/artifact-storage'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { buildWorkspaceProfile } from '@/lib/reamon/inventory'
import { parseImportManifest, workspaceImportLimits } from '@/lib/reamon/import-manifest'
import { normalizeRootName } from '@/lib/reamon/paths'
import { inventoryServerSource, SERVER_DIRECTORY_SOURCE_TYPE, ServerSourceError } from '@/lib/reamon/server-import'

interface RouteParams { params: Promise<{ id: string }> }

class ArtifactCapacityError extends Error {
  constructor(readonly availableBytes: string, readonly requiredBytes: string) {
    super('The artifact volume does not have enough free space for this import and active imports')
  }
}

class ArtifactCapacityUnavailableError extends Error {
  constructor() {
    super('Artifact volume capacity could not be checked; retry when storage is available')
  }
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access
    const storage = await getArtifactVolumeCapacity()
    return NextResponse.json({ limits: workspaceImportLimits(), storage }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to fetch REAmon workspace import limits:', error)
    return NextResponse.json({ error: 'Failed to fetch workspace import limits' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

function serializeImport(value: {
  id: string
  sourceType: string
  rootName: string
  status: string
  totalFiles: number
  completedFiles: number
  failedFiles: number
  totalBytes: bigint
  uploadedBytes: bigint
  errorSummary: string
  completedAt: Date | null
  rootTargetId: string | null
  rootTarget: { profile: unknown } | null
  manifest: unknown
  artifacts: Array<{ relativePath: string }>
}) {
  const manifest = Array.isArray(value.manifest) ? value.manifest as Array<{ relativePath?: unknown }> : []
  const uploaded = new Set(value.artifacts.map((artifact) => artifact.relativePath))
  const missingPaths = manifest
    .map((entry) => typeof entry.relativePath === 'string' ? entry.relativePath : '')
    .filter((relativePath) => relativePath && !uploaded.has(relativePath))
    .slice(0, 200)

  return {
    id: value.id,
    sourceType: value.sourceType,
    rootName: value.rootName,
    status: value.status,
    totalFiles: value.totalFiles,
    completedFiles: value.completedFiles,
    failedFiles: value.failedFiles,
    totalBytes: Number(value.totalBytes),
    uploadedBytes: Number(value.uploadedBytes),
    errorSummary: value.errorSummary,
    completedAt: value.completedAt?.toISOString() || null,
    rootTargetId: value.rootTargetId,
    missingPaths,
    profile: value.rootTarget?.profile || null,
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const body = await request.json() as { rootName?: unknown; sourceType?: unknown; sourcePath?: unknown; files?: unknown }
    const rootName = normalizeRootName(String(body.rootName || ''))
    const sourceType = String(body.sourceType || 'BROWSER_DIRECTORY')
    let entries
    let totalBytes
    let metadata: Record<string, unknown> = { browserSnapshot: true }
    if (sourceType === 'BROWSER_DIRECTORY') {
      ({ entries, totalBytes } = parseImportManifest(body.files))
    } else if (sourceType === SERVER_DIRECTORY_SOURCE_TYPE) {
      if (typeof body.sourcePath !== 'string' || !body.sourcePath.trim()) {
        return NextResponse.json({ error: 'A server source path is required' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
      }
      const inventory = await inventoryServerSource(body.sourcePath)
      if (!inventory.entries.length) throw new Error('At least one file is required')
      entries = inventory.entries
      totalBytes = inventory.totalBytes
      metadata = { serverSourcePath: inventory.sourcePath }
    } else {
      return NextResponse.json({ error: 'Unsupported workspace source type' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const profile = buildWorkspaceProfile([])
    await mkdir(artifactRoot(), { recursive: true })
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(1380008769, 1)`)
      const capacity = await getArtifactVolumeCapacity()
      if (!capacity.available || capacity.freeBytes === null) throw new ArtifactCapacityUnavailableError()
      const activeImports = await tx.workspaceImport.findMany({
        where: { status: { notIn: ['COMPLETED', 'CANCELLED', 'CANCELLING', 'FINALIZING'] } },
        select: { totalBytes: true, uploadedBytes: true },
      })
      const reservedBytes = activeImports.reduce((total, active) => {
        const remaining = active.totalBytes - active.uploadedBytes
        return total + (remaining > 0n ? remaining : 0n)
      }, 0n)
      const availableBytes = BigInt(capacity.freeBytes)
      const requiredBytes = reservedBytes + BigInt(totalBytes)
      if (requiredBytes > availableBytes) throw new ArtifactCapacityError(availableBytes.toString(), requiredBytes.toString())
      const rootTarget = await tx.target.create({
        data: {
          projectId,
          name: rootName,
          targetType: 'DIRECTORY',
          locator: `${sourceType === SERVER_DIRECTORY_SOURCE_TYPE ? 'server-directory' : 'directory'}:${rootName}`,
          status: 'DISCOVERED',
          profile: profile as unknown as Prisma.InputJsonValue,
        },
      })
      const workspaceImport = await tx.workspaceImport.create({
        data: {
          id: randomUUID(),
          projectId,
          rootTargetId: rootTarget.id,
          sourceType,
          rootName,
          totalFiles: entries.length,
          totalBytes: BigInt(totalBytes),
          manifest: entries as unknown as Prisma.InputJsonValue,
          metadata: metadata as Prisma.InputJsonValue,
        },
        include: { rootTarget: { select: { profile: true } }, artifacts: { select: { relativePath: true } } },
      })
      await tx.workspaceActivity.create({
        data: {
          projectId,
          actor: 'Operator',
          eventType: 'workspace.import.created',
          message: `Prepared ${rootName} for import (${entries.length.toLocaleString()} files)`,
          data: { importId: workspaceImport.id, rootName, totalFiles: entries.length, totalBytes },
        },
      })
      return workspaceImport
    })

    return NextResponse.json(serializeImport(result), { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create workspace import'
    if (error instanceof ArtifactCapacityError) {
      return NextResponse.json({
        error: message,
        availableBytes: error.availableBytes,
        requiredBytes: error.requiredBytes,
      }, { status: 507, headers: { 'Cache-Control': 'no-store' } })
    }
    if (error instanceof ArtifactCapacityUnavailableError) {
      return NextResponse.json({ error: message }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
    }
    const status = error instanceof ServerSourceError ? error.status : /limit|path|manifest|file|required|invalid|duplicate/i.test(message) ? 400 : 500
    console.error('Failed to create REAmon workspace import:', error)
    return NextResponse.json({ error: status === 400 ? message : 'Failed to create workspace import' }, { status, headers: { 'Cache-Control': 'no-store' } })
  }
}

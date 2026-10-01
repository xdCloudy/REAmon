import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { buildWorkspaceProfile } from '@/lib/reamon/inventory'
import { normalizeRelativePath, normalizeRootName } from '@/lib/reamon/paths'

interface RouteParams { params: Promise<{ id: string }> }

const DEFAULT_MAX_FILES = 50_000
const DEFAULT_MAX_IMPORT_BYTES = 8 * 1024 * 1024 * 1024
const DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

function configuredPositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function limits() {
  return {
    maxFiles: configuredPositiveInt('REAMON_MAX_IMPORT_FILES', DEFAULT_MAX_FILES),
    maxImportBytes: configuredPositiveInt('REAMON_MAX_IMPORT_BYTES', DEFAULT_MAX_IMPORT_BYTES),
    maxArtifactBytes: configuredPositiveInt('REAMON_MAX_ARTIFACT_BYTES', DEFAULT_MAX_ARTIFACT_BYTES),
  }
}

interface ManifestEntry {
  relativePath: string
  size: number
  lastModified: number | null
}

function parseManifest(value: unknown): { entries: ManifestEntry[]; totalBytes: number } {
  const { maxFiles, maxImportBytes, maxArtifactBytes } = limits()
  if (!Array.isArray(value) || value.length === 0) throw new Error('At least one file is required')
  if (value.length > maxFiles) throw new Error(`Import exceeds the ${maxFiles.toLocaleString()} file limit`)

  const seen = new Set<string>()
  let totalBytes = 0
  const entries = value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid import manifest entry')
    const candidate = raw as Record<string, unknown>
    const relativePath = normalizeRelativePath(String(candidate.relativePath || ''))
    if (seen.has(relativePath)) throw new Error(`Duplicate path in import manifest: ${relativePath}`)
    seen.add(relativePath)
    const size = Number(candidate.size)
    if (!Number.isSafeInteger(size) || size < 0 || size > maxArtifactBytes) {
      throw new Error(`Invalid or oversized artifact: ${relativePath}`)
    }
    totalBytes += size
    if (totalBytes > maxImportBytes) throw new Error(`Import exceeds the configured byte limit`)
    const lastModified = candidate.lastModified == null ? null : Number(candidate.lastModified)
    return {
      relativePath,
      size,
      lastModified: Number.isFinite(lastModified) ? lastModified : null,
    }
  })
  return { entries, totalBytes }
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

    const body = await request.json() as { rootName?: unknown; sourceType?: unknown; files?: unknown }
    const rootName = normalizeRootName(String(body.rootName || ''))
    const sourceType = String(body.sourceType || 'BROWSER_DIRECTORY')
    if (sourceType !== 'BROWSER_DIRECTORY') {
      return NextResponse.json({ error: 'Unsupported workspace source type' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const { entries, totalBytes } = parseManifest(body.files)
    const profile = buildWorkspaceProfile([])
    const result = await prisma.$transaction(async (tx) => {
      const rootTarget = await tx.target.create({
        data: {
          projectId,
          name: rootName,
          targetType: 'DIRECTORY',
          locator: `directory:${rootName}`,
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
          metadata: { browserSnapshot: true, maxFiles: limits().maxFiles },
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
    const status = /limit|path|manifest|file|required|invalid|duplicate/i.test(message) ? 400 : 500
    console.error('Failed to create REAmon workspace import:', error)
    return NextResponse.json({ error: status === 400 ? message : 'Failed to create workspace import' }, { status, headers: { 'Cache-Control': 'no-store' } })
  }
}

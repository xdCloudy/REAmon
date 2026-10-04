import archiver from 'archiver'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'
import { MAINTAINED_SOURCE_OBSERVATION_SOURCE, MAINTAINED_SOURCE_OBSERVATION_TYPE } from '@/lib/reamon/code-units'

interface RouteParams { params: Promise<{ id: string }> }
const MAX_MAINTAINED_UNITS = 25_000
const MAX_SOURCE_BYTES = 512 * 1024
const MAX_ARCHIVE_SOURCE_BYTES = 512 * 1024 * 1024

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function safeSourceName(originalPath: string): string {
  return path.basename(originalPath).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'maintained-source.txt'
}

function safeArchivePath(value: string): string | null {
  const segments = value.split('/')
  if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) return null
  const cleaned = segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, '_'))
  if (cleaned.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return cleaned.join('/')
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const maintainedRows = await prisma.reamonObservation.findMany({
      where: {
        projectId,
        source: MAINTAINED_SOURCE_OBSERVATION_SOURCE,
        type: MAINTAINED_SOURCE_OBSERVATION_TYPE,
        artifact: { is: selection.artifactWhere },
      },
      orderBy: [{ updatedAt: 'desc' }, { stableKey: 'asc' }],
      take: MAX_MAINTAINED_UNITS + 1,
      select: { stableKey: true, artifactId: true, attributes: true, updatedAt: true },
    })
    if (maintainedRows.length > MAX_MAINTAINED_UNITS) {
      return NextResponse.json({ error: `This workspace has more than ${MAX_MAINTAINED_UNITS.toLocaleString()} maintained files; export smaller source groups.` }, { status: 413 })
    }
    if (!maintainedRows.length) {
      return NextResponse.json({ error: 'There are no maintained source files in the active workspace import yet.' }, { status: 404 })
    }

    const unitsById = new Map<string, { id: string; artifactId: string | null; label: string | null; attributes: unknown }>()
    const unitIds = maintainedRows.map((row) => row.stableKey)
    for (let index = 0; index < unitIds.length; index += 500) {
      const rows = await prisma.reamonObservation.findMany({
        where: {
          projectId,
          id: { in: unitIds.slice(index, index + 500) },
          type: 'code_unit',
          artifact: { is: selection.artifactWhere },
        },
        select: { id: true, artifactId: true, label: true, attributes: true },
      })
      for (const row of rows) unitsById.set(row.id, row)
    }

    const storageRoot = await realpath(derivedArtifactRoot())
    const archive = archiver('zip', { zlib: { level: 6 } })
    const manifestEntries: Array<Record<string, unknown>> = []
    const archiveNames = new Set<string>()
    let exportedFiles = 0
    let skippedFiles = 0
    let totalSourceBytes = 0

    for (const maintained of maintainedRows) {
      const unit = unitsById.get(maintained.stableKey)
      const unitAttributes = plainObject(unit?.attributes)
      const originalPath = typeof unitAttributes.codeArtifactId === 'string' ? unitAttributes.codeArtifactId : ''
      const expectedPrefix = unit?.artifactId ? `${projectId}/${unit.artifactId}/` : ''
      const segments = originalPath.split('/')
      const reason = !unit || !unit.artifactId || maintained.artifactId !== unit.artifactId
        ? 'Code unit is no longer available in the active workspace import.'
        : !originalPath.startsWith(expectedPrefix) || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))
          ? 'The linked original source path is invalid.'
          : null
      if (reason) {
        skippedFiles += 1
        manifestEntries.push({ unitId: maintained.stableKey, status: 'skipped', reason })
        continue
      }

      const relativeMaintainedPath = `${projectId}/maintained/${createHash('sha256').update(maintained.stableKey).digest('hex')}-${safeSourceName(originalPath)}`
      let sourcePath: string
      let sourceBytes = 0
      try {
        sourcePath = await realpath(resolveDerivedArtifactPath(relativeMaintainedPath))
        if (!isInside(storageRoot, sourcePath)) throw new Error('Maintained source path is outside storage.')
        const sourceInfo = await stat(sourcePath)
        if (!sourceInfo.isFile() || sourceInfo.size > MAX_SOURCE_BYTES) throw new Error('Maintained source is missing or exceeds the export limit.')
        sourceBytes = sourceInfo.size
      } catch (error) {
        skippedFiles += 1
        manifestEntries.push({
          unitId: maintained.stableKey,
          name: unitAttributes.qualifiedName || unitAttributes.name || unit?.label || maintained.stableKey,
          status: 'skipped',
          reason: error instanceof Error ? error.message : 'Maintained source file could not be read.',
        })
        continue
      }

      if (totalSourceBytes + sourceBytes > MAX_ARCHIVE_SOURCE_BYTES) {
        skippedFiles += 1
        manifestEntries.push({ unitId: maintained.stableKey, status: 'skipped', reason: 'The 512 MiB archive source limit was reached.' })
        continue
      }

      const artifactRelativePath = originalPath.slice(expectedPrefix.length)
      let archivePath = safeArchivePath(`sources/${artifactRelativePath}`)
      if (!archivePath) {
        skippedFiles += 1
        manifestEntries.push({ unitId: maintained.stableKey, status: 'skipped', reason: 'The linked source path cannot be represented safely in the archive.' })
        continue
      }
      if (archiveNames.has(archivePath.toLowerCase())) {
        const parsed = path.posix.parse(archivePath)
        archivePath = `${parsed.dir}/${parsed.name}-${createHash('sha256').update(maintained.stableKey).digest('hex').slice(0, 8)}${parsed.ext}`
      }
      archiveNames.add(archivePath.toLowerCase())
      archive.file(sourcePath, { name: archivePath })
      totalSourceBytes += sourceBytes
      exportedFiles += 1
      manifestEntries.push({
        unitId: maintained.stableKey,
        name: unitAttributes.qualifiedName || unitAttributes.name || unit?.label || maintained.stableKey,
        language: unitAttributes.language || 'unknown',
        originalDecompiledPath: originalPath,
        archivePath,
        updatedAt: maintained.updatedAt instanceof Date ? maintained.updatedAt.toISOString() : maintained.updatedAt,
        bytes: sourceBytes,
        status: 'exported',
      })
    }

    archive.append(Buffer.from('REAmon maintained source export\n\nOnly saved maintained copies are included. Decompiled originals are preserved in their run-scoped paths; maintained copies have not been substituted over the originals. See manifest.json for unit names, languages, provenance, and skipped files. Review and build the exported sources with the appropriate toolchain before relying on them.\n'), { name: 'README.txt' })
    archive.append(Buffer.from(JSON.stringify({
      formatVersion: 1,
      projectId,
      exportedAt: new Date().toISOString(),
      exportedFiles,
      skippedFiles,
      sourceBytes: totalSourceBytes,
      files: manifestEntries,
    }, null, 2)), { name: 'manifest.json' })
    archive.finalize()

    const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'workspace'
    const filename = `reamon-maintained-source-${safeProjectId}.zip`
    return new Response(Readable.toWeb(archive as unknown as Readable) as ReadableStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    console.error('Failed to export REAmon maintained sources:', error)
    return NextResponse.json({ error: 'Failed to export maintained source files' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

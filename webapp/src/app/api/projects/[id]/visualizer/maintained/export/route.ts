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
import { CODE_UNIT_OBSERVATION_TYPE, MAINTAINED_SOURCE_OBSERVATION_SOURCE, MAINTAINED_SOURCE_OBSERVATION_TYPE } from '@/lib/reamon/code-units'

interface RouteParams { params: Promise<{ id: string }> }
const MAX_CODE_UNITS = 25_000
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
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

function sourceLayoutPath(originalPath: string, artifactPrefix: string, taskId: string): string {
  const relative = originalPath.slice(artifactPrefix.length)
  const segments = relative.split('/')
  return segments.length > 2 && segments[0] === taskId ? segments.slice(2).join('/') : relative
}

function uniqueArchivePath(value: string, unitId: string, used: Set<string>): string {
  if (!used.has(value.toLowerCase())) {
    used.add(value.toLowerCase())
    return value
  }
  const parsed = path.posix.parse(value)
  const suffix = createHash('sha256').update(unitId).digest('hex').slice(0, 8)
  let candidate = `${parsed.dir}/${parsed.name}-${suffix}${parsed.ext}`
  let suffixNumber = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = `${parsed.dir}/${parsed.name}-${suffix}-${suffixNumber}${parsed.ext}`
    suffixNumber += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const taskId = new URL(request.url).searchParams.get('taskId')?.trim() || ''
    if (!taskId || taskId.length > 128) return NextResponse.json({ error: 'Choose a completed analysis run to export.' }, { status: 400 })
    const selection = await getActiveWorkspaceImportSelection(projectId)
    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        projectId,
        capability: { in: ['decompile', 'disassemble'] },
        status: 'COMPLETED',
        artifact: { is: selection.artifactWhere },
      },
      select: { id: true, title: true, artifactId: true, provider: { select: { pluginId: true } }, artifact: { select: { originalName: true } } },
    })
    if (!task?.artifactId) return NextResponse.json({ error: 'Completed analysis run not found in the active workspace import.' }, { status: 404 })

    const codeUnits = await prisma.reamonObservation.findMany({
      where: {
        projectId,
        taskId: task.id,
        type: CODE_UNIT_OBSERVATION_TYPE,
        artifact: { is: selection.artifactWhere },
      },
      orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
      take: MAX_CODE_UNITS + 1,
      select: { id: true, stableKey: true, label: true, artifactId: true, attributes: true },
    })
    if (codeUnits.length > MAX_CODE_UNITS) {
      return NextResponse.json({ error: `This run has more than ${MAX_CODE_UNITS.toLocaleString()} code units; export a smaller analysis run.` }, { status: 413 })
    }
    if (!codeUnits.length) return NextResponse.json({ error: 'This run has no code units to export.' }, { status: 404 })

    const maintainedRows = await prisma.reamonObservation.findMany({
      where: {
        projectId,
        source: MAINTAINED_SOURCE_OBSERVATION_SOURCE,
        type: MAINTAINED_SOURCE_OBSERVATION_TYPE,
        stableKey: { in: codeUnits.map((unit) => unit.id) },
        artifact: { is: selection.artifactWhere },
      },
      select: { stableKey: true, artifactId: true, updatedAt: true },
    })
    const maintainedByUnit = new Map(maintainedRows.map((row) => [row.stableKey, row]))
    const maintainedSourceRows = await prisma.reamonMaintainedSource.findMany({
      where: { projectId, codeUnitId: { in: codeUnits.map((unit) => unit.id) } },
      select: { codeUnitId: true, artifactId: true, sourceCode: true, updatedAt: true },
    })
    const maintainedSourceByUnit = new Map(maintainedSourceRows.map((row) => [row.codeUnitId, row]))
    const storageRoot = await realpath(derivedArtifactRoot())
    const archive = archiver('zip', { zlib: { level: 6 } })
    const manifestEntries: Array<Record<string, unknown>> = []
    const decompiledArchivePaths = new Set<string>()
    const maintainedArchivePaths = new Set<string>()
    let decompiledFiles = 0
    let maintainedFiles = 0
    let skippedFiles = 0
    let totalSourceBytes = 0

    for (const unit of codeUnits) {
      const attributes = plainObject(unit.attributes)
      const originalPath = typeof attributes.codeArtifactId === 'string' ? attributes.codeArtifactId : ''
      const expectedPrefix = `${projectId}/${task.artifactId}/`
      const segments = originalPath.split('/')
      const invalidPath = unit.artifactId !== task.artifactId
        || !originalPath.startsWith(expectedPrefix)
        || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))
      if (invalidPath) {
        skippedFiles += 1
        manifestEntries.push({ unitId: unit.id, name: attributes.qualifiedName || attributes.name || unit.label || unit.stableKey, status: 'skipped', reason: 'The linked source path is invalid or outside this analysis artifact.' })
        continue
      }

      const artifactRelativePath = sourceLayoutPath(originalPath, expectedPrefix, task.id)
      const decompiledPath = safeArchivePath(`decompiled/${artifactRelativePath}`)
      const maintainedPath = safeArchivePath(`maintained/${artifactRelativePath}`)
      if (!decompiledPath || !maintainedPath) {
        skippedFiles += 1
        manifestEntries.push({ unitId: unit.id, name: attributes.qualifiedName || attributes.name || unit.label || unit.stableKey, status: 'skipped', reason: 'The linked source path cannot be represented safely in the archive.' })
        continue
      }

      let decompiledStatus: 'exported' | 'skipped' = 'skipped'
      let decompiledReason: string | undefined
      let safeOriginalPath: string | null = null
      let originalBytes = 0
      try {
        safeOriginalPath = await realpath(resolveDerivedArtifactPath(originalPath))
        if (!isInside(storageRoot, safeOriginalPath)) throw new Error('Original decompilation path is outside storage.')
        const originalInfo = await stat(safeOriginalPath)
        if (!originalInfo.isFile() || originalInfo.size > MAX_SOURCE_BYTES) throw new Error('Original decompilation is missing or exceeds the 2 MiB per-file export limit.')
        originalBytes = originalInfo.size
        if (!decompiledArchivePaths.has(decompiledPath.toLowerCase())) {
          if (totalSourceBytes + originalBytes > MAX_ARCHIVE_SOURCE_BYTES) throw new Error('The 512 MiB archive source limit was reached.')
          archive.file(safeOriginalPath, { name: decompiledPath })
          decompiledArchivePaths.add(decompiledPath.toLowerCase())
          totalSourceBytes += originalBytes
          decompiledFiles += 1
        }
        decompiledStatus = 'exported'
      } catch (error) {
        skippedFiles += 1
        decompiledReason = error instanceof Error ? error.message : 'Original decompilation could not be read.'
      }

      let maintainedStatus: 'exported' | 'not_saved' | 'skipped' = 'not_saved'
      let maintainedReason: string | undefined
      let maintainedArchivePath: string | null = null
      let maintainedBytes = 0
      const maintained = maintainedByUnit.get(unit.id)
      const maintainedSource = maintainedSourceByUnit.get(unit.id)
      if (maintained) {
        if (maintained.artifactId !== task.artifactId) {
          maintainedStatus = 'skipped'
          maintainedReason = 'Maintained source belongs to a different input artifact.'
          skippedFiles += 1
        } else {
          const relativeMaintainedPath = `${projectId}/maintained/${createHash('sha256').update(unit.id).digest('hex')}-${safeSourceName(originalPath)}`
          try {
            let maintainedContent: Buffer | string
            if (maintainedSource?.artifactId === task.artifactId) {
              maintainedContent = maintainedSource.sourceCode
              maintainedBytes = Buffer.byteLength(maintainedContent, 'utf8')
            } else {
              const safeMaintainedPath = await realpath(resolveDerivedArtifactPath(relativeMaintainedPath))
              if (!isInside(storageRoot, safeMaintainedPath)) throw new Error('Maintained source path is outside storage.')
              const maintainedInfo = await stat(safeMaintainedPath)
              if (!maintainedInfo.isFile() || maintainedInfo.size > MAX_SOURCE_BYTES) throw new Error('Maintained source is missing or exceeds the 2 MiB per-file export limit.')
              maintainedBytes = maintainedInfo.size
              maintainedContent = await readFile(safeMaintainedPath)
            }
            if (maintainedBytes > MAX_SOURCE_BYTES) throw new Error('Maintained source exceeds the 2 MiB per-file export limit.')
            if (totalSourceBytes + maintainedBytes > MAX_ARCHIVE_SOURCE_BYTES) throw new Error('The 512 MiB archive source limit was reached.')
            maintainedArchivePath = uniqueArchivePath(maintainedPath, unit.id, maintainedArchivePaths)
            archive.append(maintainedContent, { name: maintainedArchivePath })
            totalSourceBytes += maintainedBytes
            maintainedFiles += 1
            maintainedStatus = 'exported'
          } catch (error) {
            maintainedStatus = 'skipped'
            maintainedReason = error instanceof Error ? error.message : 'Maintained source could not be read.'
            skippedFiles += 1
          }
        }
      }

      manifestEntries.push({
        unitId: unit.id,
        name: attributes.qualifiedName || attributes.name || unit.label || unit.stableKey,
        language: attributes.language || 'unknown',
        originalDecompiledPath: originalPath,
        decompiledPath: decompiledStatus === 'exported' ? decompiledPath : null,
        decompiledStatus,
        ...(decompiledReason ? { decompiledReason } : {}),
        maintainedPath: maintainedStatus === 'exported' ? maintainedArchivePath : null,
        maintainedStatus,
        ...(maintainedReason ? { maintainedReason } : {}),
        updatedAt: maintainedSource?.updatedAt instanceof Date
          ? maintainedSource.updatedAt.toISOString()
          : maintained?.updatedAt instanceof Date ? maintained.updatedAt.toISOString() : maintained?.updatedAt || null,
        decompiledBytes: decompiledStatus === 'exported' ? originalBytes : null,
        maintainedBytes: maintainedStatus === 'exported' ? maintainedBytes : null,
      })
    }

    archive.append(Buffer.from([
      'REAmon analysis source bundle',
      '',
      `Analysis run: ${task.title}`,
      `Analyzer: ${task.provider?.pluginId || 'unknown'}`,
      `Input: ${task.artifact?.originalName || 'unknown'}`,
      '',
      'decompiled/ contains the analyzer output. maintained/ contains saved edited or AI-assisted copies when available.',
      'The two trees are kept separate; maintained source never overwrites the decompilation.',
      'See manifest.json for unit-level provenance, missing files, and export status.',
      'This bundle does not include build scripts or dependencies. Review and build with the appropriate toolchain before relying on it.',
      '',
    ].join('\n')), { name: 'README.txt' })
    archive.append(Buffer.from(JSON.stringify({
      formatVersion: 2,
      projectId,
      taskId: task.id,
      taskTitle: task.title,
      providerId: task.provider?.pluginId || null,
      inputArtifact: task.artifact?.originalName || null,
      exportedAt: new Date().toISOString(),
      codeUnitCount: codeUnits.length,
      decompiledFiles,
      maintainedFiles,
      skippedFiles,
      sourceBytes: totalSourceBytes,
      files: manifestEntries,
    }, null, 2)), { name: 'manifest.json' })
    archive.finalize()

    const safeTaskId = task.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'analysis'
    const filename = `reamon-source-bundle-${safeTaskId}.zip`
    return new Response(Readable.toWeb(archive as unknown as Readable) as ReadableStream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    console.error('Failed to export REAmon analysis sources:', error)
    return NextResponse.json({ error: 'Failed to export analysis source files' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

import archiver from 'archiver'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'
import { CODE_UNIT_OBSERVATION_TYPE, MAINTAINED_SOURCE_OBSERVATION_SOURCE, MAINTAINED_SOURCE_OBSERVATION_TYPE } from '@/lib/reamon/code-units'
import { getVerifiedCSharpProjectBuildReceipt } from '@/lib/reamon/project-build-receipt'
import { getVerifiedGoProjectBuildReceipt } from '@/lib/reamon/go-project-build-receipt'

interface RouteParams { params: Promise<{ id: string }> }
const MAX_CODE_UNITS = 25_000
const MAX_DRAFT_ROWS = 50_000
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_ARCHIVE_SOURCE_BYTES = 512 * 1024 * 1024
const MAX_NATIVE_ANNOTATION_BYTES = 8 * 1024 * 1024
const MAX_PROTECTION_EVIDENCE_ROWS = 64
const MAX_PROTECTION_EVIDENCE_TEXT = 4000

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function protectionEvidenceManifestEntry(row: {
  id: string
  stableKey: string
  taskId: string | null
  source: string
  attributes: unknown
  updatedAt: Date
}) {
  const attributes = plainObject(row.attributes)
  const assessment = attributes.assessment
  const supportedAssessments = new Set(['detected', 'suspected', 'unknown', 'confirmed'])
  const family = typeof attributes.family === 'string' ? attributes.family.slice(0, 100) : null
  const evidence = typeof attributes.evidence === 'string' ? attributes.evidence.slice(0, MAX_PROTECTION_EVIDENCE_TEXT) : null
  const scope = typeof attributes.scope === 'string' ? attributes.scope.slice(0, 500) : null
  const inspectedBytes = typeof attributes.inspectedBytes === 'number' && Number.isSafeInteger(attributes.inspectedBytes) && attributes.inspectedBytes >= 0
    ? attributes.inspectedBytes
    : null

  return {
    observationId: row.id,
    stableKey: row.stableKey.slice(0, 256),
    taskId: row.taskId,
    source: row.source.slice(0, 128),
    assessment: typeof assessment === 'string' && supportedAssessments.has(assessment) ? assessment : 'unclassified',
    family,
    evidence,
    scope,
    inspectedBytes,
    confirmedClaim: attributes.confirmed === true,
    recordedAt: row.updatedAt.toISOString(),
  }
}

function maintainedSymbolNames(value: unknown): string[] {
  const symbols = Array.isArray(value) ? value : plainObject(value).symbols
  if (!Array.isArray(symbols)) return []
  return [...new Set(symbols.filter((symbol): symbol is string =>
    typeof symbol === 'string' && symbol.length > 1 && symbol.length <= 128))].slice(0, 512)
}

function maintainedRenameAliases(value: unknown): Array<{ bindingId: string; oldName: string; newName: string; kind: string }> {
  const aliases = plainObject(value).aliases
  if (!Array.isArray(aliases)) return []
  return aliases.flatMap((value) => {
    const alias = plainObject(value)
    if (typeof alias.bindingId !== 'string' || !/^[a-f0-9]{24}$/i.test(alias.bindingId)
        || typeof alias.oldName !== 'string' || alias.oldName.length > 128
        || typeof alias.newName !== 'string' || alias.newName.length > 128
        || typeof alias.kind !== 'string' || alias.kind.length > 80) return []
    return [{ bindingId: alias.bindingId.toLowerCase(), oldName: alias.oldName, newName: alias.newName, kind: alias.kind }]
  }).slice(0, 200)
}

function uniqueNativeFunctionDeclaration(value: unknown): { name: string; line: number; parserVersion: string | null } | null {
  const index = plainObject(value)
  if (index.truncated === true || !Array.isArray(index.members)) return null
  const candidates = index.members.flatMap((value) => {
    const member = plainObject(value)
    if (member.kind !== 'function' || typeof member.name !== 'string'
        || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(member.name)
        || !Number.isSafeInteger(member.line) || (member.line as number) < 1) return []
    return [{ name: member.name, line: member.line as number }]
  })
  if (candidates.length !== 1) return null
  return {
    ...candidates[0],
    parserVersion: typeof index.parserVersion === 'string' ? index.parserVersion.slice(0, 80) : null,
  }
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

async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
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
      select: {
        id: true,
        title: true,
        artifactId: true,
        provider: { select: { pluginId: true, version: true } },
        artifact: { select: { originalName: true, sha256: true, sizeBytes: true, mimeType: true } },
      },
    })
    if (!task?.artifactId) return NextResponse.json({ error: 'Completed analysis run not found in the active workspace import.' }, { status: 404 })
    const csharpBuildReceipt = await getVerifiedCSharpProjectBuildReceipt(projectId, task.id, task.artifactId)
    const goBuildReceipt = await getVerifiedGoProjectBuildReceipt(projectId, task.id, task.artifactId, selection.artifactWhere)

    const protectionEvidenceRows = await prisma.reamonObservation.findMany({
      where: { projectId, artifactId: task.artifactId, type: 'protection_assessment' },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: MAX_PROTECTION_EVIDENCE_ROWS + 1,
      select: { id: true, stableKey: true, taskId: true, source: true, attributes: true, updatedAt: true },
    })
    const protectionEvidenceTruncated = protectionEvidenceRows.length > MAX_PROTECTION_EVIDENCE_ROWS
    const protectionEvidence = protectionEvidenceRows.slice(0, MAX_PROTECTION_EVIDENCE_ROWS).map(protectionEvidenceManifestEntry)

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
      select: { codeUnitId: true, artifactId: true, sourceCode: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true, updatedAt: true },
    })
    const maintainedSourceByUnit = new Map(maintainedSourceRows.map((row) => [row.codeUnitId, row]))
    const reviewIds = [...new Set(maintainedSourceRows.flatMap((row) => row.acceptedReviewId ? [row.acceptedReviewId] : []))]
    const reviewClient = (prisma as typeof prisma & { reamonCodeReview?: typeof prisma.reamonCodeReview }).reamonCodeReview
    const reviews = reviewIds.length && reviewClient ? await reviewClient.findMany({
      where: { projectId, id: { in: reviewIds } },
      select: { id: true, artifactId: true, codeUnitId: true, reviewerId: true, decision: true, maintainedSourceHash: true, symbolIndexSnapshot: true, validationStatus: true, validationMethod: true, createdAt: true },
    }) : []
    const reviewById = new Map(reviews.map((review) => [review.id, review]))
    const exportableMaintainedSources = maintainedSourceRows.filter((source) => {
      if (!source.sourceHash || source.artifactId !== task.artifactId || !source.acceptedReviewId) return false
      const receipt = reviewById.get(source.acceptedReviewId)
      return receipt?.artifactId === task.artifactId
        && receipt.codeUnitId === source.codeUnitId
        && receipt.decision === 'ACCEPTED'
        && receipt.maintainedSourceHash === source.sourceHash
    })
    const runKeyByUnit = new Map(codeUnits.map((unit) => {
      const codeArtifactId = plainObject(unit.attributes).codeArtifactId
      const segments = typeof codeArtifactId === 'string' ? codeArtifactId.split('/') : []
      return [unit.id, segments.length >= 4 ? segments.slice(0, 4).join('/') : ''] as const
    }))
    const exportableUnitIds = [...new Set(exportableMaintainedSources.map((source) => source.codeUnitId))]
    const exportableSourceHashes = [...new Set(exportableMaintainedSources.flatMap((source) => source.sourceHash ? [source.sourceHash] : []))]
    // Check run keys after fetch so the two bounded IN lists stay below PostgreSQL's bind-parameter limit.
    const draftRows = exportableUnitIds.length && exportableSourceHashes.length
      ? await prisma.reamonCodeDraft.findMany({
        where: {
          projectId,
          artifactId: task.artifactId,
          codeUnitId: { in: exportableUnitIds },
          scope: 'file',
          draftHash: { in: exportableSourceHashes },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: MAX_DRAFT_ROWS + 1,
        select: {
          id: true,
          codeUnitId: true,
          runKey: true,
          sourceAttemptId: true,
          sourceHash: true,
          draftHash: true,
          providerName: true,
          modelIdentifier: true,
          validationStatus: true,
          validationMethod: true,
          updatedAt: true,
          sourceAttempt: {
            select: {
              id: true,
              status: true,
              resultSource: true,
              validationStatus: true,
              validationMethod: true,
              completedAt: true,
            },
          },
        },
      })
      : []
    const draftSearchTruncated = draftRows.length > MAX_DRAFT_ROWS
    const drafts = draftRows.slice(0, MAX_DRAFT_ROWS)
    const draftByUnit = new Map<string, typeof drafts[number]>()
    for (const draft of drafts) {
      const maintainedSource = maintainedSourceByUnit.get(draft.codeUnitId)
      if (!maintainedSource?.sourceHash
          || draft.runKey !== runKeyByUnit.get(draft.codeUnitId)
          || draft.draftHash !== maintainedSource.sourceHash
          || draftByUnit.has(draft.codeUnitId)) continue
      draftByUnit.set(draft.codeUnitId, draft)
    }
    const storageRoot = await realpath(derivedArtifactRoot())
    const archive = archiver('zip', { zlib: { level: 6 } })
    const manifestEntries: Array<Record<string, unknown>> = []
    const nativeAnnotationEntries: Array<Record<string, unknown>> = []
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
      let decompiledSha256: string | null = null
      try {
        safeOriginalPath = await realpath(resolveDerivedArtifactPath(originalPath))
        if (!isInside(storageRoot, safeOriginalPath)) throw new Error('Original decompilation path is outside storage.')
        const originalInfo = await stat(safeOriginalPath)
        if (!originalInfo.isFile() || originalInfo.size > MAX_SOURCE_BYTES) throw new Error('Original decompilation is missing or exceeds the 2 MiB per-file export limit.')
        originalBytes = originalInfo.size
        decompiledSha256 = await fileSha256(safeOriginalPath)
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
      let maintainedSha256: string | null = null
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
            maintainedSha256 = createHash('sha256').update(maintainedContent).digest('hex')
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

      const maintainedHashMatchesStored = Boolean(maintainedSha256
        && maintainedSource?.sourceHash
        && maintainedSource.sourceHash === maintainedSha256)
      const maintainedReceipt = maintainedSource?.acceptedReviewId
        ? reviewById.get(maintainedSource.acceptedReviewId)
        : undefined
      const maintainedReceiptVerified = Boolean(maintainedStatus === 'exported'
        && maintainedSource?.artifactId === task.artifactId
        && maintainedHashMatchesStored
        && maintainedSha256
        && maintainedReceipt?.artifactId === task.artifactId
        && maintainedReceipt.codeUnitId === unit.id
        && maintainedReceipt.decision === 'ACCEPTED'
        && maintainedReceipt.maintainedSourceHash === maintainedSha256)
      if (task.provider?.pluginId === 'reamon-ghidra' && maintainedReceiptVerified && maintainedSource
          && maintainedReceipt?.symbolIndexSnapshot !== null && maintainedReceipt?.symbolIndexSnapshot !== undefined) {
        const acceptedSymbolIndex = maintainedReceipt.symbolIndexSnapshot
        const address = typeof attributes.address === 'string' ? attributes.address
          : typeof attributes.startAddress === 'string' ? attributes.startAddress : ''
        const acceptedSymbolNames = maintainedSymbolNames(acceptedSymbolIndex)
        const acceptedRenameHistory = maintainedRenameAliases(acceptedSymbolIndex)
        const functionDeclaration = uniqueNativeFunctionDeclaration(acceptedSymbolIndex)
        if (address && (acceptedSymbolNames.length || acceptedRenameHistory.length || functionDeclaration)) nativeAnnotationEntries.push({
          codeUnitId: unit.id,
          stableKey: unit.stableKey,
          originalName: attributes.qualifiedName || attributes.name || unit.label || unit.stableKey,
          address,
          addressKind: 'ghidra-address',
          architecture: typeof attributes.instructionArchitecture === 'string' ? attributes.instructionArchitecture : null,
          language: typeof attributes.language === 'string' ? attributes.language : 'unknown',
          acceptedSymbolNames,
          acceptedRenameHistory,
          ...(functionDeclaration ? {
            functionDeclaration: {
              ...functionDeclaration,
              mapping: 'unique function declaration in the exact accepted source file',
            },
          } : {}),
          acceptedSourceSha256: maintainedSha256,
          review: {
            id: maintainedReceipt.id,
            reviewerId: maintainedReceipt.reviewerId,
            createdAt: maintainedReceipt.createdAt.toISOString(),
            validationStatus: maintainedReceipt.validationStatus,
            validationMethod: maintainedReceipt.validationMethod,
          },
          evidence: 'Symbols were indexed from this exact human-accepted maintained source for the address-associated Ghidra code unit. This does not map every listed identifier to the function address.',
        })
      }
      const maintainedDraft = draftByUnit.get(unit.id)
      const attemptOutputSha256 = maintainedDraft?.sourceAttempt?.resultSource
        ? createHash('sha256').update(maintainedDraft.sourceAttempt.resultSource).digest('hex')
        : null
      const maintainedAttemptMatchesDraft = Boolean(maintainedDraft?.sourceAttemptId
        && maintainedDraft.sourceAttempt?.id === maintainedDraft.sourceAttemptId
        && maintainedDraft.sourceAttempt.status === 'SUCCEEDED'
        && attemptOutputSha256
        && attemptOutputSha256 === maintainedDraft.draftHash)

      manifestEntries.push({
        unitId: unit.id,
        name: attributes.qualifiedName || attributes.name || unit.label || unit.stableKey,
        language: attributes.language || 'unknown',
        engineVersion: typeof attributes.engineVersion === 'string' ? attributes.engineVersion : null,
        originalDecompiledPath: originalPath,
        decompiledPath: decompiledStatus === 'exported' ? decompiledPath : null,
        decompiledStatus,
        decompiledSha256,
        ...(decompiledReason ? { decompiledReason } : {}),
        maintainedPath: maintainedStatus === 'exported' ? maintainedArchivePath : null,
        maintainedStatus,
        maintainedSha256,
        maintainedStoredSha256: maintainedSource?.sourceHash || null,
        maintainedHashMatchesStored: maintainedSha256 && maintainedSource?.sourceHash ? maintainedHashMatchesStored : null,
        maintainedReviewId: maintainedSource?.acceptedReviewId || null,
        maintainedReviewStatus: maintainedStatus === 'exported'
          ? maintainedReceiptVerified
            ? 'verified'
            : maintainedReceipt
              ? 'mismatch'
              : maintainedSource?.acceptedReviewId && !reviewClient ? 'unavailable' : 'missing'
          : null,
        maintainedDraftId: maintainedDraft?.id || null,
        maintainedDraftStatus: maintainedStatus === 'exported'
          ? maintainedDraft
            ? maintainedDraft.draftHash === maintainedSha256 ? 'matches_exported_source' : 'hash_mismatch'
            : draftSearchTruncated ? 'search_truncated' : 'missing'
          : null,
        maintainedDraftHash: maintainedDraft?.draftHash || null,
        maintainedDraftInputHash: maintainedDraft?.sourceHash || null,
        maintainedDraftProvider: maintainedDraft ? {
          name: maintainedDraft.providerName,
          model: maintainedDraft.modelIdentifier,
        } : null,
        maintainedDraftValidation: maintainedDraft ? {
          status: maintainedDraft.validationStatus,
          method: maintainedDraft.validationMethod,
        } : null,
        maintainedAttemptId: maintainedDraft?.sourceAttemptId || null,
        maintainedAttemptOutputSha256: attemptOutputSha256,
        maintainedAttemptMatchesDraft: maintainedDraft ? maintainedAttemptMatchesDraft : null,
        maintainedAttemptValidation: maintainedDraft?.sourceAttempt ? {
          status: maintainedDraft.sourceAttempt.validationStatus,
          method: maintainedDraft.sourceAttempt.validationMethod,
          completedAt: maintainedDraft.sourceAttempt.completedAt?.toISOString() || null,
        } : null,
        ...(maintainedReceipt ? {
          maintainedReview: {
            reviewerId: maintainedReceipt.reviewerId,
            decision: maintainedReceipt.decision,
            createdAt: maintainedReceipt.createdAt.toISOString(),
            validationStatus: maintainedReceipt.validationStatus,
            validationMethod: maintainedReceipt.validationMethod,
          },
        } : {}),
        ...(maintainedReason ? { maintainedReason } : {}),
        updatedAt: maintainedSource?.updatedAt instanceof Date
          ? maintainedSource.updatedAt.toISOString()
          : maintained?.updatedAt instanceof Date ? maintained.updatedAt.toISOString() : maintained?.updatedAt || null,
        decompiledBytes: decompiledStatus === 'exported' ? originalBytes : null,
        maintainedBytes: maintainedStatus === 'exported' ? maintainedBytes : null,
      })
    }

    const nativeAnnotations = task.provider?.pluginId === 'reamon-ghidra' && nativeAnnotationEntries.length
      ? {
        schema: 'reamon.native-annotations.v1',
        binary: {
          name: task.artifact?.originalName || 'unknown',
          sha256: task.artifact?.sha256 || null,
          sizeBytes: task.artifact?.sizeBytes || null,
          mimeType: task.artifact?.mimeType || null,
        },
        analysis: { taskId: task.id, provider: task.provider.pluginId, providerVersion: task.provider.version },
        addressSemantics: 'Ghidra address from the original analysis. This schema does not claim RVA semantics and does not authorize rebasing.',
        entries: nativeAnnotationEntries,
        truncated: false as boolean,
      }
      : null
    let nativeAnnotationsBuffer: Buffer | null = null
    if (nativeAnnotations) {
      const requestedEntryCount = nativeAnnotationEntries.length
      let low = 0
      let high = requestedEntryCount
      let acceptedEntryCount = 0
      let boundedBuffer: Buffer | null = null
      while (low <= high) {
        const candidateCount = Math.floor((low + high) / 2)
        const candidate = Buffer.from(JSON.stringify({
          ...nativeAnnotations,
          entries: nativeAnnotationEntries.slice(0, candidateCount),
          truncated: candidateCount < requestedEntryCount,
        }, null, 2))
        if (candidate.byteLength <= MAX_NATIVE_ANNOTATION_BYTES) {
          acceptedEntryCount = candidateCount
          boundedBuffer = candidate
          low = candidateCount + 1
        } else {
          high = candidateCount - 1
        }
      }
      if (acceptedEntryCount) {
        nativeAnnotationEntries.length = acceptedEntryCount
        nativeAnnotations.truncated = acceptedEntryCount < requestedEntryCount
        nativeAnnotationsBuffer = boundedBuffer
        if (nativeAnnotationsBuffer) archive.append(nativeAnnotationsBuffer, { name: 'native-annotations.json' })
      }
    }
    const hasImportableNativeNames = nativeAnnotationEntries.some((entry) => Boolean(plainObject(entry.functionDeclaration).name))
    const ghidraImporterBuffer = hasImportableNativeNames
      ? await readFile(path.join(process.cwd(), 'public', 'reamon', 'ImportReamonAnnotations.py'))
      : null
    if (ghidraImporterBuffer) archive.append(ghidraImporterBuffer, { name: 'tools/ImportReamonAnnotations.py' })

    archive.append(Buffer.from([
      'REAmon analysis source bundle',
      '',
      `Analysis run: ${task.title}`,
      `Analyzer: ${task.provider?.pluginId || 'unknown'}`,
      `Input: ${task.artifact?.originalName || 'unknown'}`,
      '',
      'decompiled/ contains the analyzer output. maintained/ contains saved edited or AI-assisted copies when available.',
      'The two trees are kept separate; maintained source never overwrites the decompilation.',
      'See manifest.json for artifact and file hashes, maintained-source receipt verification, matching draft and attempt lineage, validation metadata, missing files, export status, and any current verified project build evidence.',
      'protectionEvidence contains persisted provider assessments for the input artifact; its labels are hypotheses and are not independent confirmation of protection or successful recovery.',
      ...(nativeAnnotationsBuffer ? ['A Ghidra source bundle also contains native-annotations.json with accepted evidence tied to the exact input binary hash. It does not authorize address rebasing.'] : []),
      ...(ghidraImporterBuffer ? ['To apply unique native function names, add tools/ to Ghidra Script Manager, run ImportReamonAnnotations.py, and select this bundle root manifest.json. The script verifies the sidecar hash, exact loaded executable SHA-256, and each original function name; it never rebases addresses. Review its reported skips before saving the Ghidra project.'] : []),
      'This bundle does not include build scripts or dependencies. Review and build with the appropriate toolchain before relying on it.',
      '',
    ].join('\n')), { name: 'README.txt' })
    archive.append(Buffer.from(JSON.stringify({
      formatVersion: 3,
      projectId,
      taskId: task.id,
      taskTitle: task.title,
      provider: task.provider ? { id: task.provider.pluginId, version: task.provider.version } : null,
      inputArtifact: task.artifact ? {
        name: task.artifact.originalName,
        sha256: task.artifact.sha256,
        sizeBytes: Number(task.artifact.sizeBytes),
        mimeType: task.artifact.mimeType,
      } : null,
      exportedAt: new Date().toISOString(),
      codeUnitCount: codeUnits.length,
      decompiledFiles,
      maintainedFiles,
      draftSearchTruncated,
      skippedFiles,
      sourceBytes: totalSourceBytes,
      protectionEvidence,
      protectionEvidenceTruncated,
      ...(csharpBuildReceipt || goBuildReceipt ? { buildEvidence: {
        ...(goBuildReceipt ? { goProject: {
          schema: goBuildReceipt.version,
          validationStatus: goBuildReceipt.validationStatus,
          validationMethod: goBuildReceipt.validationMethod,
          compilerVersion: goBuildReceipt.compilerVersion,
          sourceSetSha256: goBuildReceipt.sourceSha256,
          dependencySetSha256: goBuildReceipt.dependencySha256,
          compiledPackagesSha256: goBuildReceipt.compiledSha256,
          packageCount: goBuildReceipt.packageCount,
          compiledArtifactsIncluded: false,
          createdAt: goBuildReceipt.createdAt,
          files: [...goBuildReceipt.files]
            .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
            .map((file) => ({
              codeUnitId: file.codeUnitId,
              acceptedReviewId: file.acceptedReviewId,
              relativePath: file.relativePath,
              sourceSha256: file.sourceSha256,
            })),
          dependencies: [...goBuildReceipt.dependencies]
            .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
            .map((dependency) => ({
              relativePath: dependency.relativePath,
              manifestPath: dependency.buildPath,
              sourceSha256: dependency.sourceSha256,
            })),
        } } : {}),
        ...(csharpBuildReceipt ? { csharpProject: {
          schema: csharpBuildReceipt.version,
          validationStatus: csharpBuildReceipt.validationStatus,
          validationMethod: csharpBuildReceipt.validationMethod,
          compilerVersion: csharpBuildReceipt.compilerVersion,
          sourceSetSha256: csharpBuildReceipt.sourceSha256,
          compiledAssemblySha256: csharpBuildReceipt.compiledSha256,
          compiledAssemblyIncluded: false,
          createdAt: csharpBuildReceipt.createdAt,
          files: [...csharpBuildReceipt.files]
            .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
            .map((file) => ({
              codeUnitId: file.codeUnitId,
              acceptedReviewId: file.acceptedReviewId,
              relativePath: file.relativePath,
              sourceSha256: file.sourceSha256,
            })),
        } } : {}),
      } } : {}),
      ...(nativeAnnotationsBuffer ? {
        nativeAnnotations: {
          schema: 'reamon.native-annotations.v1',
          path: 'native-annotations.json',
          sha256: createHash('sha256').update(nativeAnnotationsBuffer).digest('hex'),
          entryCount: nativeAnnotationEntries.length,
          truncated: Boolean(nativeAnnotations?.truncated),
        },
        ...(ghidraImporterBuffer ? { ghidraImporter: {
          path: 'tools/ImportReamonAnnotations.py',
          sha256: createHash('sha256').update(ghidraImporterBuffer).digest('hex'),
        } } : {}),
      } : {}),
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

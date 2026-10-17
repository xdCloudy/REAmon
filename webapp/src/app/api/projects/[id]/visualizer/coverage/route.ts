import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { CODE_UNIT_OBSERVATION_TYPE, normalizeCodeUnit } from '@/lib/reamon/code-units'

interface RouteParams { params: Promise<{ id: string }> }

// Coverage hashes stored source text, so keep source-bearing DB batches small.
const PAGE_SIZE = 64
const DRAFT_PAGE_SIZE = 32

function runKeyFor(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null
  const codeArtifactId = (attributes as Record<string, unknown>).codeArtifactId
  if (typeof codeArtifactId !== 'string') return null
  const segments = codeArtifactId.split('/')
  return segments.length >= 4 ? segments.slice(0, 4).join('/') : null
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const taskId = new URL(request.url).searchParams.get('taskId')?.trim() || ''
    if (!taskId || taskId.length > 128) {
      return NextResponse.json({ error: 'A completed analysis run is required' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        projectId,
        capability: { in: ['decompile', 'disassemble'] },
        status: 'COMPLETED',
        artifact: { is: selection.artifactWhere },
      },
      select: { id: true, artifactId: true },
    })
    if (!task) return NextResponse.json({ error: 'Analysis run not found' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })

    const codeUnitWhere = {
      projectId,
      taskId: task.id,
      type: CODE_UNIT_OBSERVATION_TYPE,
      artifact: { is: selection.artifactWhere },
    }
    let cursor: string | undefined
    let codeUnitCount = 0
    let maintainedUnitCount = 0
    let reviewedUnitCount = 0
    let validatedUnitCount = 0
    let unmatchedLegacyValidationUnitCount = 0
    let sourceLinkedUnitCount = 0
    let codeBytes = 0
    let measuredBytes = 0
    let decompiledBytes = 0
    while (true) {
      const rows = await prisma.reamonObservation.findMany({
        where: { ...codeUnitWhere, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        select: { id: true, stableKey: true, label: true, source: true, artifactId: true, updatedAt: true, attributes: true },
      })
      if (rows.length === 0) break
      const validRows: typeof rows = []
      for (const row of rows) {
        const unit = normalizeCodeUnit({
          id: row.id,
          stableKey: row.stableKey || '',
          label: row.label,
          source: row.source || '',
          artifactId: row.artifactId,
          updatedAt: row.updatedAt || new Date(0),
          attributes: row.attributes || {},
        })
        if (!unit) continue
        validRows.push(row)
        codeBytes += unit.sizeBytes
        if (unit.artifactId && unit.codeArtifactId) sourceLinkedUnitCount += 1
        if (unit.coveragePercent !== null) {
          measuredBytes += unit.sizeBytes
          decompiledBytes += unit.sizeBytes * (unit.coveragePercent / 100)
        }
      }
      codeUnitCount += validRows.length
      const unitIds = validRows.map((row) => row.id)
      const artifactIds = [...new Set(validRows.flatMap((row) => row.artifactId ? [row.artifactId] : []))]
      const maintainedSources = unitIds.length && artifactIds.length ? await prisma.reamonMaintainedSource.findMany({
        where: { projectId, codeUnitId: { in: unitIds }, artifactId: { in: artifactIds } },
        select: { codeUnitId: true, artifactId: true, sourceCode: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true },
      }) : []
      const currentSourceHashByUnit = new Map(validRows.map((row) => {
        const attributes = row.attributes && typeof row.attributes === 'object' && !Array.isArray(row.attributes)
          ? row.attributes as Record<string, unknown>
          : {}
        const candidate = attributes.codeArtifactSha256 ?? attributes.decompiledSourceSha256
        return [row.id, typeof candidate === 'string' && /^[a-f0-9]{64}$/i.test(candidate) ? candidate.toLowerCase() : null] as const
      }))
      const currentMaintainedSources = maintainedSources.filter((source) => {
        if (!source.sourceHash
          || !/^[a-f0-9]{64}$/i.test(source.sourceHash)
          || createHash('sha256').update(source.sourceCode).digest('hex') !== source.sourceHash.toLowerCase()) return false
        const index = source.symbolIndex && typeof source.symbolIndex === 'object' && !Array.isArray(source.symbolIndex)
          ? source.symbolIndex as Record<string, unknown>
          : {}
        const lineage = index.sourceLineage && typeof index.sourceLineage === 'object' && !Array.isArray(index.sourceLineage)
          ? index.sourceLineage as Record<string, unknown>
          : {}
        const baseSourceHash = lineage.baseSourceHash
        return typeof baseSourceHash === 'string'
          && /^[a-f0-9]{64}$/i.test(baseSourceHash)
          && baseSourceHash.toLowerCase() === currentSourceHashByUnit.get(source.codeUnitId)
      })
      const reviewIds = [...new Set(maintainedSources.flatMap((source) => source.acceptedReviewId ? [source.acceptedReviewId] : []))]
      const reviewRows = reviewIds.length ? await prisma.reamonCodeReview.findMany({
        where: { projectId, id: { in: reviewIds }, decision: 'ACCEPTED' },
        select: { id: true, codeUnitId: true, artifactId: true, maintainedSourceHash: true },
      }) : []
      const reviewById = new Map(reviewRows.map((review) => [review.id, review]))
      const runKeyByUnit = new Map(validRows.map((row) => [row.id, runKeyFor(row.attributes)]))
      const reviewedSources = currentMaintainedSources.filter((source) => {
        if (!source.sourceHash || !source.acceptedReviewId) return false
        const review = reviewById.get(source.acceptedReviewId)
        return review?.codeUnitId === source.codeUnitId
          && review.artifactId === source.artifactId
          && review.maintainedSourceHash === source.sourceHash
      })
      maintainedUnitCount += new Set(reviewedSources.map((source) => source.codeUnitId)).size
      const reviewedUnitIds = new Set(reviewedSources.map((source) => source.codeUnitId))
      reviewedUnitCount += reviewedUnitIds.size

      const sourceHashes = [...new Set(reviewedSources.flatMap((source) => source.sourceHash ? [source.sourceHash.toLowerCase()] : []))]
      const runKeys = [...new Set(reviewedSources.flatMap((source) => {
        const runKey = runKeyByUnit.get(source.codeUnitId)
        return runKey ? [runKey] : []
      }))]
      const reviewedUnitIdsWithRunKey = reviewedSources.filter((source) => runKeyByUnit.get(source.codeUnitId))
      const expectedValidation = new Map(reviewedUnitIdsWithRunKey.map((source) => {
        const runKey = runKeyByUnit.get(source.codeUnitId) as string
        return [`${source.codeUnitId}:${source.artifactId}:${runKey}`, source.sourceHash?.toLowerCase() ?? null]
      }))
      const candidateDraftWhere = {
        projectId,
        artifactId: { in: artifactIds },
        codeUnitId: { in: reviewedUnitIdsWithRunKey.map((source) => source.codeUnitId) },
        runKey: { in: runKeys },
        scope: 'file',
        validationStatus: 'PASSED',
      }
      const matchedValidationUnitIds = new Set<string>()
      const legacyValidationUnitIds = new Set<string>()
      let draftCursor: string | undefined
      while (sourceHashes.length && runKeys.length) {
        const drafts = await prisma.reamonCodeDraft.findMany({
          where: { ...candidateDraftWhere, draftHash: { in: sourceHashes }, ...(draftCursor ? { id: { gt: draftCursor } } : {}) },
          orderBy: { id: 'asc' },
          take: DRAFT_PAGE_SIZE,
          select: {
            id: true, codeUnitId: true, artifactId: true, runKey: true, sourceCode: true, draftHash: true,
            sourceAttempt: { select: { status: true, scope: true, resultSource: true, syntaxValidated: true, validationStatus: true } },
          },
        })
        for (const draft of drafts) {
          const key = `${draft.codeUnitId}:${draft.artifactId}:${draft.runKey}`
          const expectedHash = expectedValidation.get(key)
          const attempt = draft.sourceAttempt
          if (expectedHash && draft.draftHash?.toLowerCase() === expectedHash
            && createHash('sha256').update(draft.sourceCode).digest('hex') === expectedHash
            && attempt?.status === 'SUCCEEDED' && attempt.scope === 'file'
            && attempt.resultSource === draft.sourceCode && attempt.syntaxValidated === true
            && attempt.validationStatus === 'PASSED') {
            matchedValidationUnitIds.add(draft.codeUnitId)
          }
        }
        if (drafts.length < DRAFT_PAGE_SIZE) break
        draftCursor = drafts.at(-1)?.id
      }
      let legacyDraftCursor: string | undefined
      while (runKeys.length) {
        const drafts = await prisma.reamonCodeDraft.findMany({
          where: { ...candidateDraftWhere, draftHash: null, ...(legacyDraftCursor ? { id: { gt: legacyDraftCursor } } : {}) },
          orderBy: { id: 'asc' },
          take: DRAFT_PAGE_SIZE,
          select: { id: true, codeUnitId: true, artifactId: true, runKey: true },
        })
        for (const draft of drafts) {
          const key = `${draft.codeUnitId}:${draft.artifactId}:${draft.runKey}`
          if (expectedValidation.has(key)) legacyValidationUnitIds.add(draft.codeUnitId)
        }
        if (drafts.length < DRAFT_PAGE_SIZE) break
        legacyDraftCursor = drafts.at(-1)?.id
      }
      validatedUnitCount += matchedValidationUnitIds.size
      unmatchedLegacyValidationUnitCount += [...legacyValidationUnitIds].filter((unitId) => !matchedValidationUnitIds.has(unitId)).length
      if (rows.length < PAGE_SIZE) break
      cursor = rows.at(-1)?.id
    }

    return NextResponse.json({
      taskId: task.id,
      codeUnitCount,
      maintainedUnitCount,
      reviewedUnitCount,
      validatedUnitCount,
      unmatchedLegacyValidationUnitCount,
      coveragePercent: codeUnitCount > 0 ? Math.round((maintainedUnitCount / codeUnitCount) * 100) : 0,
      reviewedPercent: codeUnitCount > 0 ? Math.round((reviewedUnitCount / codeUnitCount) * 100) : 0,
      validatedPercent: codeUnitCount > 0 ? Math.round((validatedUnitCount / codeUnitCount) * 100) : 0,
      decompilationCoveragePercent: measuredBytes > 0 ? Math.round((decompiledBytes / measuredBytes) * 100) : null,
      sourceLinkedPercent: codeUnitCount > 0 ? Math.round((sourceLinkedUnitCount / codeUnitCount) * 100) : 0,
      codeBytes,
      measuredBytes,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to load REAmon maintained-source coverage:', error)
    return NextResponse.json({ error: 'Failed to load maintained-source coverage' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

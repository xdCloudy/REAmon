import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'
import { MAINTAINED_SOURCE_OBSERVATION_SOURCE, MAINTAINED_SOURCE_OBSERVATION_TYPE } from '@/lib/reamon/code-units'
import { extractMaintainedSymbols } from '@/lib/reamon/maintenance-memory'

interface RouteParams { params: Promise<{ id: string; unitId: string }> }
const MAX_SOURCE_BYTES = 2 * 1024 * 1024

class MaintainedSourceConflict extends Error {}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

async function maintainedSymbolIndex(sourceCode: string, language: string): Promise<string[]> {
  try {
    const response = await agentFetch('/reamon/code/index-symbols', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_code: sourceCode, language }),
    }, { timeoutMs: 5_000 })
    if (response.ok) {
      const result = await response.json().catch(() => null) as { indexed?: boolean; symbols?: unknown } | null
      if (result?.indexed === true && Array.isArray(result.symbols)) {
        return [...new Set(result.symbols.filter((symbol): symbol is string => typeof symbol === 'string' && symbol.length > 1 && symbol.length <= 128))].slice(0, 512)
      }
    }
  } catch {
    // Saving maintained source stays available when the optional parser service is down.
  }
  return extractMaintainedSymbols(sourceCode, language)
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function safeFileName(value: string): string {
  const base = path.basename(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120)
  return base && base !== '.' && base !== '..' ? base : 'maintained-source.txt'
}

async function resolveUnit(projectId: string, unitId: string) {
  const user = await requireEffectiveUser()
  if (user instanceof NextResponse) return { response: user } as const
  const access = await requireProjectAccess(user, projectId)
  if (access instanceof NextResponse) return { response: access } as const
  const observation = await prisma.reamonObservation.findFirst({
    where: { id: unitId, projectId, type: 'code_unit' },
    select: { id: true, artifactId: true, label: true, attributes: true },
  })
  if (!observation?.artifactId) return { response: NextResponse.json({ error: 'Code unit not found' }, { status: 404 }) } as const
  const selection = await getActiveWorkspaceImportSelection(projectId)
  const artifact = await prisma.artifact.findFirst({
    where: { AND: [{ id: observation.artifactId, projectId }, selection.artifactWhere] },
    select: { id: true },
  })
  if (!artifact) return { response: NextResponse.json({ error: 'Code unit is not part of the active workspace' }, { status: 404 }) } as const
  const attributes = plainObject(observation.attributes)
  const originalPath = typeof attributes.codeArtifactId === 'string' ? attributes.codeArtifactId : ''
  const prefix = `${projectId}/${artifact.id}/`
  const segments = originalPath.split('/')
  if (!originalPath.startsWith(prefix) || segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
    return { response: NextResponse.json({ error: 'Code unit has no valid linked source artifact' }, { status: 404 }) } as const
  }
  const extension = path.extname(originalPath).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 16)
  const sourceName = path.basename(originalPath).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || `source${extension || '.txt'}`
  const relativePath = `${projectId}/maintained/${createHash('sha256').update(unitId).digest('hex')}-${sourceName}`
  return { projectId, unitId, reviewerId: user.userId, observation, attributes, artifactId: artifact.id, originalPath, relativePath } as const
}

async function checkedPath(relativePath: string) {
  const root = derivedArtifactRoot()
  const absolute = resolveDerivedArtifactPath(relativePath)
  const [rootRealPath, fileRealPath] = await Promise.all([realpath(root), realpath(absolute).catch(() => null)])
  if (fileRealPath && !isInside(rootRealPath, fileRealPath)) throw new Error('Maintained source path is invalid')
  return { rootRealPath, absolute, fileRealPath }
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, unitId } = await params
    const resolved = await resolveUnit(projectId, unitId)
    if ('response' in resolved) return resolved.response
    const { absolute, fileRealPath } = await checkedPath(resolved.relativePath)
    const [savedSource, reviews] = await Promise.all([
      prisma.reamonMaintainedSource.findUnique({
        where: { projectId_codeUnitId: { projectId, codeUnitId: unitId } },
        select: { sourceCode: true, updatedAt: true },
      }),
      prisma.reamonCodeReview.findMany({
        where: { projectId, codeUnitId: unitId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, reviewerId: true, decision: true, rationale: true, maintainedSourceHash: true, createdAt: true },
      }),
    ])
    const reviewHistory = reviews.map((review) => ({ ...review, createdAt: review.createdAt.toISOString() }))
    if (savedSource) {
      if (new URL(request.url).searchParams.get('download') === '1') {
        return new NextResponse(savedSource.sourceCode, {
          headers: {
            'Cache-Control': 'private, no-store',
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="${safeFileName(path.basename(absolute))}"`,
            'X-Content-Type-Options': 'nosniff',
          },
        })
      }
      return NextResponse.json({ exists: true, sourceCode: savedSource.sourceCode, sourceHash: createHash('sha256').update(savedSource.sourceCode).digest('hex'), updatedAt: savedSource.updatedAt.toISOString(), reviews: reviewHistory }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    if (!fileRealPath) return NextResponse.json({ exists: false, sourceCode: null }, { headers: { 'Cache-Control': 'private, no-store' } })
    const info = await stat(fileRealPath)
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return NextResponse.json({ error: 'Maintained source exceeds the view limit' }, { status: 413 })
    const sourceCode = await readFile(fileRealPath, 'utf8')
    if (new URL(request.url).searchParams.get('download') === '1') {
      return new NextResponse(sourceCode, {
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${safeFileName(path.basename(absolute))}"`,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
    return NextResponse.json({ exists: true, sourceCode, sourceHash: null, updatedAt: info.mtime.toISOString(), reviews: reviewHistory }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to load maintained REAmon source:', error)
    return NextResponse.json({ error: 'Failed to load maintained source' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, unitId } = await params
    const resolved = await resolveUnit(projectId, unitId)
    if ('response' in resolved) return resolved.response
    let body: unknown
    try { body = await request.json() } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })
    }
    const requestBody = plainObject(body)
    const sourceCode = requestBody.sourceCode
    const expectedSourceHash = requestBody.expectedSourceHash === undefined || requestBody.expectedSourceHash === null
      ? null
      : typeof requestBody.expectedSourceHash === 'string' && /^[a-f0-9]{64}$/i.test(requestBody.expectedSourceHash)
        ? requestBody.expectedSourceHash.toLowerCase()
        : ''
    const reviewRationale = typeof requestBody.reviewRationale === 'string' ? requestBody.reviewRationale.trim() : ''
    if (typeof sourceCode !== 'string' || !sourceCode.trim()) return NextResponse.json({ error: 'Maintained source cannot be empty' }, { status: 400 })
    if (Buffer.byteLength(sourceCode, 'utf8') > MAX_SOURCE_BYTES) return NextResponse.json({ error: 'Maintained source exceeds the save limit' }, { status: 413 })
    if (reviewRationale.length < 12 || reviewRationale.length > 1000) {
      return NextResponse.json({ error: 'Add a review rationale between 12 and 1000 characters before accepting this source.' }, { status: 400 })
    }
    if (expectedSourceHash === '') return NextResponse.json({ error: 'The maintained source version is invalid. Reload it before accepting changes.' }, { status: 400 })

    const original = await checkedPath(resolved.originalPath)
    if (original.fileRealPath) {
      const originalInfo = await stat(original.fileRealPath)
      if (originalInfo.isFile() && originalInfo.size <= MAX_SOURCE_BYTES) {
        const originalSource = await readFile(original.fileRealPath, 'utf8')
        const normalize = (value: string) => value.replace(/\r\n?/g, '\n').trim()
        if (normalize(sourceCode) === normalize(originalSource)) {
          return NextResponse.json({ error: 'This source matches the original decompilation. Edit it or create a maintained version before saving.' }, { status: 422 })
        }
      }
    }

    const attributes = resolved.attributes
    const label = (typeof attributes.qualifiedName === 'string' && attributes.qualifiedName)
      || (typeof attributes.name === 'string' && attributes.name)
      || resolved.observation.label
      || resolved.unitId
    const language = typeof attributes.language === 'string' ? attributes.language.slice(0, 80) : 'unknown'
    const symbolIndex = await maintainedSymbolIndex(sourceCode, language)
    const now = new Date().toISOString()
    const { rootRealPath, absolute } = await checkedPath(resolved.relativePath)
    const maintainedSourceHash = createHash('sha256').update(sourceCode).digest('hex')
    const review = await prisma.$transaction(async (tx) => {
      const currentSource = await tx.reamonMaintainedSource.findUnique({
        where: { projectId_codeUnitId: { projectId, codeUnitId: resolved.unitId } },
        select: { sourceCode: true, sourceHash: true },
      })
      const currentSourceHash = currentSource
        ? createHash('sha256').update(currentSource.sourceCode).digest('hex')
        : null
      if (currentSourceHash !== expectedSourceHash) throw new MaintainedSourceConflict()
      await tx.reamonObservation.upsert({
        where: {
          projectId_source_stableKey: {
            projectId,
            source: MAINTAINED_SOURCE_OBSERVATION_SOURCE,
            stableKey: resolved.unitId,
          },
        },
        update: {
          artifactId: resolved.artifactId,
          kind: 'source',
          type: MAINTAINED_SOURCE_OBSERVATION_TYPE,
          canonicalKey: `maintained-source:${resolved.artifactId}:${resolved.unitId}`,
          label,
          attributes: { unitId: resolved.unitId, relativePath: resolved.relativePath, updatedAt: now },
        },
        create: {
          projectId,
          artifactId: resolved.artifactId,
          source: MAINTAINED_SOURCE_OBSERVATION_SOURCE,
          stableKey: resolved.unitId,
          kind: 'source',
          type: MAINTAINED_SOURCE_OBSERVATION_TYPE,
          canonicalKey: `maintained-source:${resolved.artifactId}:${resolved.unitId}`,
          label,
          attributes: { unitId: resolved.unitId, relativePath: resolved.relativePath, updatedAt: now },
        },
      })
      const review = await tx.reamonCodeReview.create({
        data: {
          projectId,
          artifactId: resolved.artifactId,
          codeUnitId: resolved.unitId,
          reviewerId: resolved.reviewerId,
          decision: 'ACCEPTED',
          rationale: reviewRationale,
          maintainedSourceHash,
        },
        select: { id: true, reviewerId: true, decision: true, rationale: true, maintainedSourceHash: true, createdAt: true },
      })
      const sourceData = {
        artifactId: resolved.artifactId,
        unitName: label,
        language,
        sourceCode,
        sourceHash: maintainedSourceHash,
        acceptedReviewId: review.id,
        symbolIndex,
        relativePath: resolved.relativePath,
      }
      if (currentSource) {
        const updated = await tx.reamonMaintainedSource.updateMany({
          where: { projectId, codeUnitId: resolved.unitId, sourceHash: currentSource.sourceHash },
          data: sourceData,
        })
        if (updated.count !== 1) throw new MaintainedSourceConflict()
      } else {
        await tx.reamonMaintainedSource.create({
          data: { projectId, codeUnitId: resolved.unitId, ...sourceData },
        })
      }
      return review
    })
    const temporaryPath = `${absolute}.${randomUUID()}.tmp`
    try {
      await mkdir(path.dirname(absolute), { recursive: true })
      const parentPath = await realpath(path.dirname(absolute))
      if (!isInside(rootRealPath, parentPath)) throw new Error('Maintained source path is invalid')
      await writeFile(temporaryPath, sourceCode, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, absolute)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      console.error('Could not mirror the saved maintained source to derived storage:', error)
    }
    return NextResponse.json({
      saved: true,
      review: { ...review, createdAt: review.createdAt.toISOString() },
      fileName: safeFileName(path.basename(absolute)),
      downloadUrl: `/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/${encodeURIComponent(unitId)}?download=1`,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof MaintainedSourceConflict || isUniqueConflict(error)) {
      return NextResponse.json({ error: 'The maintained source changed after you opened it. Reload the current version and review it before saving again.' }, { status: 409 })
    }
    console.error('Failed to save maintained REAmon source:', error)
    return NextResponse.json({ error: 'Failed to save maintained source' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

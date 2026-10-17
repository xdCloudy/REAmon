import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { resolveDerivedArtifactPath, derivedArtifactRoot } from '@/lib/reamon/derived-storage'
import { isValidationRegression } from '@/lib/reamon/validation-regression'

interface RouteParams { params: Promise<{ id: string; unitId: string }> }
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const SMALI_CODE_UNIT_PREFIX = 'smali:'

class MaintainedSourceConflict extends Error {}
class MaintainedSourceValidationRegression extends Error {}

interface SmaliValidation {
  source_sha256: string
  validation_status: 'PASSED' | 'FAILED' | 'UNAVAILABLE'
  validation_method: string | null
  validation_message: string
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function validateSmaliSource(sourceCode: string, expectedHash: string): Promise<SmaliValidation> {
  const unavailable = (message: string): SmaliValidation => ({
    source_sha256: expectedHash,
    validation_status: 'UNAVAILABLE',
    validation_method: 'smali-assembler',
    validation_message: message,
  })
  const baseUrl = process.env.REAMON_JADX_URL?.trim().replace(/\/$/, '')
  if (!baseUrl) return unavailable('The isolated Smali validation service is not configured.')
  try {
    const response = await fetch(`${baseUrl}/validate-smali`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceCode }),
      signal: AbortSignal.timeout(20_000),
      cache: 'no-store',
    })
    const payload = await response.json().catch(() => null) as Partial<SmaliValidation> | null
    if (!response.ok || !payload || payload.source_sha256 !== expectedHash
      || !['PASSED', 'FAILED', 'UNAVAILABLE'].includes(String(payload.validation_status))) {
      return unavailable('The isolated Smali assembler returned an incomplete or mismatched validation result.')
    }
    return {
      source_sha256: expectedHash,
      validation_status: payload.validation_status as SmaliValidation['validation_status'],
      validation_method: typeof payload.validation_method === 'string' ? payload.validation_method.slice(0, 80) : null,
      validation_message: typeof payload.validation_message === 'string' ? payload.validation_message.slice(0, 2000) : 'No validation message was returned.',
    }
  } catch {
    return unavailable('The isolated Smali assembler is unavailable; syntax validation was not recorded.')
  }
}

async function resolveSmali(projectId: string, unitId: string) {
  const user = await requireEffectiveUser()
  if (user instanceof NextResponse) return { response: user } as const
  const access = await requireProjectAccess(user, projectId)
  if (access instanceof NextResponse) return { response: access } as const
  const selection = await getActiveWorkspaceImportSelection(projectId)
  const unit = await prisma.reamonObservation.findFirst({
    where: { id: unitId, projectId, type: 'code_unit', task: { provider: { is: { pluginId: 'reamon-jadx' } } }, artifact: { is: selection.artifactWhere } },
    select: { id: true, taskId: true, artifactId: true, label: true, attributes: true, task: { select: { runToken: true, status: true, capability: true } } },
  })
  if (!unit?.taskId || !unit.artifactId || unit.task?.status !== 'COMPLETED' || unit.task.capability !== 'decompile' || !unit.task.runToken) {
    return { response: NextResponse.json({ error: 'Completed Android code unit not found' }, { status: 404 }) } as const
  }
  const attributes = object(unit.attributes)
  const relativePath = attributes.disassemblyArtifactId
  const expectedPrefix = `${projectId}/${unit.artifactId}/${unit.taskId}/${unit.task.runToken}/disassembly/`
  if (typeof relativePath !== 'string' || !relativePath.startsWith(expectedPrefix) || !relativePath.endsWith('.smali') || relativePath.includes('\\') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    return { response: NextResponse.json({ error: 'This code unit has no linked Smali source' }, { status: 404 }) } as const
  }
  const absolute = resolveDerivedArtifactPath(relativePath)
  const [root, file] = await Promise.all([realpath(derivedArtifactRoot()), realpath(absolute).catch(() => null)])
  if (!file || !isInside(root, file)) return { response: NextResponse.json({ error: 'Linked Smali source is unavailable' }, { status: 404 }) } as const
  const info = await stat(file)
  if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return { response: NextResponse.json({ error: 'Smali source exceeds the 2 MiB edit limit' }, { status: 413 }) } as const
  return { unit, reviewerId: user.userId, relativePath, file } as const
}

function classDescriptor(sourceCode: string): string | null {
  const declarations = [...sourceCode.matchAll(/^\s*\.class\s+(?:(?:public|private|protected|static|final|abstract|interface|enum|synthetic|annotation|constructor|declared-synchronized)\s+)*(L[^\s;]+;)\s*$/gm)]
  return declarations.length === 1 ? declarations[0][1] : null
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, unitId } = await params
    const resolved = await resolveSmali(projectId, unitId)
    if ('response' in resolved) return resolved.response
    const codeUnitId = `${SMALI_CODE_UNIT_PREFIX}${unitId}`
    const revisionId = new URL(request.url).searchParams.get('revision')
    if (revisionId) {
      if (revisionId.length > 128) return NextResponse.json({ error: 'Invalid accepted Smali revision' }, { status: 400 })
      const revision = await prisma.reamonCodeReview.findFirst({
        where: { id: revisionId, projectId, artifactId: resolved.unit.artifactId!, codeUnitId, decision: 'ACCEPTED' },
        select: { id: true, maintainedSourceHash: true, sourceSnapshot: true, createdAt: true },
      })
      if (!revision?.sourceSnapshot) {
        return NextResponse.json({ error: 'This accepted Smali source predates version snapshots or its source is unavailable.' }, { status: 404 })
      }
      if (Buffer.byteLength(revision.sourceSnapshot, 'utf8') > MAX_SOURCE_BYTES
          || createHash('sha256').update(revision.sourceSnapshot).digest('hex') !== revision.maintainedSourceHash) {
        return NextResponse.json({ error: 'The saved accepted Smali snapshot failed its integrity check.' }, { status: 409 })
      }
      return NextResponse.json({
        sourceCode: revision.sourceSnapshot,
        sourceHash: revision.maintainedSourceHash,
        revisionId: revision.id,
        createdAt: revision.createdAt.toISOString(),
      }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    const [saved, reviews, restorableReviews] = await Promise.all([
      prisma.reamonMaintainedSource.findUnique({ where: { projectId_codeUnitId: { projectId, codeUnitId } }, select: { sourceCode: true, updatedAt: true } }),
      prisma.reamonCodeReview.findMany({
        where: { projectId, codeUnitId }, orderBy: { createdAt: 'desc' }, take: 10,
        select: { id: true, reviewerId: true, decision: true, rationale: true, maintainedSourceHash: true, validationStatus: true, validationMethod: true, validationMessage: true, createdAt: true },
      }),
      prisma.reamonCodeReview.findMany({
        where: { projectId, codeUnitId, decision: 'ACCEPTED', sourceSnapshot: { not: null } },
        orderBy: { createdAt: 'desc' }, take: 10, select: { id: true },
      }),
    ])
    const sourceCode = saved?.sourceCode ?? await readFile(resolved.file, 'utf8')
    const restorableReviewIds = new Set(restorableReviews.map((review) => review.id))
    const reviewHistory = reviews.map((review) => ({
      ...review,
      sourceAvailable: restorableReviewIds.has(review.id),
      createdAt: review.createdAt.toISOString(),
    }))
    return NextResponse.json({ exists: Boolean(saved), sourceCode, sourceHash: saved ? createHash('sha256').update(saved.sourceCode).digest('hex') : null, updatedAt: saved?.updatedAt.toISOString() ?? null, reviews: reviewHistory }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to load editable Smali source:', error)
    return NextResponse.json({ error: 'Failed to load Smali source' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, unitId } = await params
    const resolved = await resolveSmali(projectId, unitId)
    if ('response' in resolved) return resolved.response
    let body: unknown
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 }) }
    const requestBody = object(body)
    const sourceCode = requestBody.sourceCode
    const expectedSourceHash = requestBody.expectedSourceHash === undefined || requestBody.expectedSourceHash === null
      ? null
      : typeof requestBody.expectedSourceHash === 'string' && /^[a-f0-9]{64}$/i.test(requestBody.expectedSourceHash)
        ? requestBody.expectedSourceHash.toLowerCase()
        : ''
    const reviewRationale = typeof requestBody.reviewRationale === 'string' ? requestBody.reviewRationale.trim() : ''
    if (typeof sourceCode !== 'string' || !sourceCode.trim()) return NextResponse.json({ error: 'Smali source cannot be empty' }, { status: 400 })
    if (Buffer.byteLength(sourceCode, 'utf8') > MAX_SOURCE_BYTES) return NextResponse.json({ error: 'Smali source exceeds the 2 MiB save limit' }, { status: 413 })
    if (reviewRationale.length < 12 || reviewRationale.length > 1000) return NextResponse.json({ error: 'Add a review rationale between 12 and 1000 characters before accepting this source.' }, { status: 400 })
    if (expectedSourceHash === '') return NextResponse.json({ error: 'The maintained Smali version is invalid. Reload it before accepting changes.' }, { status: 400 })
    const editedDescriptor = classDescriptor(sourceCode)
    const originalSource = await readFile(resolved.file, 'utf8')
    const originalDescriptor = classDescriptor(originalSource)
    if (!editedDescriptor) return NextResponse.json({ error: 'Smali must contain one valid .class descriptor declaration' }, { status: 422 })
    if (!originalDescriptor || editedDescriptor !== originalDescriptor) return NextResponse.json({ error: 'The .class descriptor must match the selected code unit' }, { status: 422 })
    const attributes = object(resolved.unit.attributes)
    const name = typeof attributes.qualifiedName === 'string' ? attributes.qualifiedName : resolved.unit.label || unitId
    const codeUnitId = `${SMALI_CODE_UNIT_PREFIX}${unitId}`
    const maintainedSourceHash = createHash('sha256').update(sourceCode).digest('hex')
    const validation = await validateSmaliSource(sourceCode, maintainedSourceHash)
    if (validation.validation_status === 'FAILED') {
      return NextResponse.json({
        error: 'The Smali assembler rejected this source; it was not accepted.',
        validationStatus: validation.validation_status,
        validationMethod: validation.validation_method,
        validationMessage: validation.validation_message,
      }, { status: 422, headers: { 'Cache-Control': 'private, no-store' } })
    }
    const review = await prisma.$transaction(async (tx) => {
      const currentSource = await tx.reamonMaintainedSource.findUnique({
        where: { projectId_codeUnitId: { projectId, codeUnitId } },
        select: { sourceCode: true, sourceHash: true, acceptedReviewId: true },
      })
      const currentSourceHash = currentSource
        ? createHash('sha256').update(currentSource.sourceCode).digest('hex')
        : null
      if (currentSourceHash !== expectedSourceHash) throw new MaintainedSourceConflict()
      if (currentSource?.acceptedReviewId && currentSourceHash) {
        const currentReceipt = await tx.reamonCodeReview.findFirst({
          where: {
            id: currentSource.acceptedReviewId,
            projectId,
            artifactId: resolved.unit.artifactId!,
            codeUnitId,
            decision: 'ACCEPTED',
            maintainedSourceHash: currentSourceHash,
          },
          select: { validationStatus: true, validationMethod: true },
        })
        if (currentReceipt && isValidationRegression(
          { status: currentReceipt.validationStatus, method: currentReceipt.validationMethod },
          { status: validation.validation_status, method: validation.validation_method },
        )) {
          throw new MaintainedSourceValidationRegression()
        }
      }
      const receipt = await tx.reamonCodeReview.create({
        data: {
          projectId,
          artifactId: resolved.unit.artifactId!,
          codeUnitId,
          reviewerId: resolved.reviewerId,
          decision: 'ACCEPTED',
          rationale: reviewRationale,
          maintainedSourceHash,
          validationStatus: validation.validation_status,
          validationMethod: validation.validation_method,
          validationMessage: validation.validation_message,
          sourceSnapshot: sourceCode,
        },
        select: { id: true, createdAt: true, validationStatus: true, validationMethod: true, validationMessage: true },
      })
      const sourceData = { artifactId: resolved.unit.artifactId!, unitName: `${name} (Smali)`, language: 'Smali', sourceCode, sourceHash: maintainedSourceHash, acceptedReviewId: receipt.id, symbolIndex: [], relativePath: resolved.relativePath }
      if (currentSource) {
        const updated = await tx.reamonMaintainedSource.updateMany({
          where: { projectId, codeUnitId, sourceHash: currentSource.sourceHash },
          data: sourceData,
        })
        if (updated.count !== 1) throw new MaintainedSourceConflict()
      } else {
        await tx.reamonMaintainedSource.create({ data: { projectId, codeUnitId, ...sourceData } })
      }
      return receipt
    })
    return NextResponse.json({
      saved: true,
      review: {
        id: review.id,
        createdAt: review.createdAt.toISOString(),
        validationStatus: review.validationStatus,
        validationMethod: review.validationMethod,
        validationMessage: review.validationMessage,
      },
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof MaintainedSourceValidationRegression) {
      return NextResponse.json({ error: 'This Smali class has an accepted source with stronger validation evidence. The new source used a weaker validator or could not be assembled, so the accepted source was kept unchanged.' }, { status: 503 })
    }
    if (error instanceof MaintainedSourceConflict || isUniqueConflict(error)) {
      return NextResponse.json({ error: 'The maintained Smali source changed after you opened it. Reload the current version and review it before saving again.' }, { status: 409 })
    }
    console.error('Failed to save editable Smali source:', error)
    return NextResponse.json({ error: 'Failed to save Smali source' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

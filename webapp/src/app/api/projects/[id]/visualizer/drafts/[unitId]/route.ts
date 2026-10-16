import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'

interface RouteParams { params: Promise<{ id: string; unitId: string }> }
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_QUESTION_CHARS = 1000
const MAX_METADATA_CHARS = 128

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
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
  const codeArtifactId = typeof attributes.codeArtifactId === 'string' ? attributes.codeArtifactId : ''
  const prefix = `${projectId}/${artifact.id}/`
  const segments = codeArtifactId.split('/')
  if (!codeArtifactId.startsWith(prefix) || segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
    return { response: NextResponse.json({ error: 'Code unit has no valid linked source artifact' }, { status: 404 }) } as const
  }
  const configuredRoot = derivedArtifactRoot()
  const sourcePath = resolveDerivedArtifactPath(codeArtifactId)
  const [rootPath, safeSourcePath] = await Promise.all([realpath(configuredRoot), realpath(sourcePath)])
  if (!isInside(rootPath, safeSourcePath)) return { response: NextResponse.json({ error: 'Linked source path is invalid' }, { status: 404 }) } as const
  const sourceInfo = await stat(safeSourcePath)
  if (!sourceInfo.isFile() || sourceInfo.size > MAX_SOURCE_BYTES) {
    return { response: NextResponse.json({ error: 'Linked source exceeds the draft limit' }, { status: 413 }) } as const
  }
  const sourceCode = await readFile(safeSourcePath, 'utf8')
  return {
    projectId,
    unitId,
    artifactId: artifact.id,
    runKey: segments.slice(0, 4).join('/'),
    unitName: (typeof attributes.qualifiedName === 'string' && attributes.qualifiedName)
      || (typeof attributes.name === 'string' && attributes.name)
      || observation.label
      || unitId,
    language: typeof attributes.language === 'string' ? attributes.language.slice(0, 80) : 'unknown',
    sourceHash: createHash('sha256').update(sourceCode).digest('hex'),
  } as const
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, unitId } = await params
    const resolved = await resolveUnit(projectId, unitId)
    if ('response' in resolved) return resolved.response
    const draft = await prisma.reamonCodeDraft.findFirst({
      where: { projectId, codeUnitId: unitId, artifactId: resolved.artifactId, runKey: resolved.runKey, sourceHash: resolved.sourceHash },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, sourceCode: true, sourceAttemptId: true, providerName: true, modelIdentifier: true, question: true, scope: true, syntaxValidated: true, validationStatus: true, validationMethod: true, validationMessage: true, updatedAt: true },
    })
    const attempts = await prisma.reamonCodeAttempt.findMany({
      where: { projectId, codeUnitId: unitId, artifactId: resolved.artifactId, runKey: resolved.runKey, sourceHash: resolved.sourceHash },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, providerName: true, modelIdentifier: true, question: true, scope: true, status: true, errorCode: true, errorMessage: true, resultSource: true, syntaxValidated: true, validationStatus: true, validationMethod: true, validationMessage: true, createdAt: true, completedAt: true },
    })
    return NextResponse.json({
      exists: Boolean(draft),
      draft: draft ? { ...draft, updatedAt: draft.updatedAt.toISOString() } : null,
      attempts: attempts.map((attempt) => ({
        ...attempt,
        createdAt: attempt.createdAt.toISOString(),
        completedAt: attempt.completedAt?.toISOString() ?? null,
      })),
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to load REAmon code draft:', error)
    return NextResponse.json({ error: 'Failed to load code draft' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, unitId } = await params
    const resolved = await resolveUnit(projectId, unitId)
    if ('response' in resolved) return resolved.response
    const body = plainObject(await request.json().catch(() => null))
    const sourceCode = body.sourceCode
    const sourceAttemptId = body.sourceAttemptId === undefined || body.sourceAttemptId === null
      ? null
      : typeof body.sourceAttemptId === 'string' ? body.sourceAttemptId.trim() : ''
    const providerName = body.providerName
    const modelIdentifier = body.model
    const question = body.question === undefined ? '' : body.question
    const scope = body.scope === undefined ? 'file' : body.scope
    const syntaxValidated = body.syntaxValidated === undefined || body.syntaxValidated === null
      ? null
      : body.syntaxValidated
    const validationStatus = body.validationStatus === undefined || body.validationStatus === null
      ? null
      : body.validationStatus
    const validationMethod = body.validationMethod === undefined || body.validationMethod === null
      ? null
      : body.validationMethod
    const validationMessage = body.validationMessage === undefined || body.validationMessage === null
      ? null
      : body.validationMessage
    if (typeof sourceCode !== 'string' || !sourceCode.trim()) return NextResponse.json({ error: 'Draft source cannot be empty' }, { status: 400 })
    if (Buffer.byteLength(sourceCode, 'utf8') > MAX_SOURCE_BYTES) return NextResponse.json({ error: 'Draft exceeds the save limit' }, { status: 413 })
    if (typeof providerName !== 'string' || !providerName.trim() || providerName.length > MAX_METADATA_CHARS
      || typeof modelIdentifier !== 'string' || !modelIdentifier.trim() || modelIdentifier.length > MAX_METADATA_CHARS
      || typeof question !== 'string' || question.length > MAX_QUESTION_CHARS
      || sourceAttemptId === '' || (sourceAttemptId !== null && sourceAttemptId.length > 128)
      || (syntaxValidated !== null && typeof syntaxValidated !== 'boolean')
      || (validationStatus !== null && !['PASSED', 'FAILED', 'UNAVAILABLE'].includes(String(validationStatus)))
      || (validationMethod !== null && (typeof validationMethod !== 'string' || validationMethod.length > 80))
      || (validationMessage !== null && (typeof validationMessage !== 'string' || validationMessage.length > 2000))
      || (scope !== 'file' && scope !== 'member')) {
      return NextResponse.json({ error: 'Draft metadata is invalid' }, { status: 400 })
    }
    if (sourceAttemptId) {
      const attempt = await prisma.reamonCodeAttempt.findFirst({
        where: {
          id: sourceAttemptId,
          projectId,
          artifactId: resolved.artifactId,
          runKey: resolved.runKey,
          codeUnitId: unitId,
          sourceHash: resolved.sourceHash,
          status: 'SUCCEEDED',
        },
        select: { id: true },
      })
      if (!attempt) return NextResponse.json({ error: 'The originating AI attempt does not match this unit and source version.' }, { status: 409 })
    }
    const draft = await prisma.reamonCodeDraft.create({
      data: {
        projectId,
        artifactId: resolved.artifactId,
        runKey: resolved.runKey,
        codeUnitId: unitId,
        sourceAttemptId,
        unitName: resolved.unitName,
        language: resolved.language,
        sourceHash: resolved.sourceHash,
        sourceCode,
        providerName: providerName.trim(),
        modelIdentifier: modelIdentifier.trim(),
        question,
        scope,
        syntaxValidated,
        validationStatus: validationStatus as string | null,
        validationMethod: validationMethod as string | null,
        validationMessage: validationMessage as string | null,
      },
      select: { id: true, sourceAttemptId: true, updatedAt: true },
    })
    return NextResponse.json({ saved: true, draftId: draft.id, sourceAttemptId: draft.sourceAttemptId, updatedAt: draft.updatedAt.toISOString() }, { status: 201, headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to save REAmon code draft:', error)
    return NextResponse.json({ error: 'Failed to save code draft' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, unitId } = await params
    const resolved = await resolveUnit(projectId, unitId)
    if ('response' in resolved) return resolved.response
    const body = plainObject(await request.json().catch(() => null))
    const draftId = typeof body.draftId === 'string' ? body.draftId.trim() : ''
    const sourceCode = body.sourceCode
    if (!draftId || draftId.length > 128 || typeof sourceCode !== 'string' || !sourceCode.trim()) {
      return NextResponse.json({ error: 'A draft id and non-empty source are required' }, { status: 400 })
    }
    if (Buffer.byteLength(sourceCode, 'utf8') > MAX_SOURCE_BYTES) return NextResponse.json({ error: 'Draft exceeds the save limit' }, { status: 413 })
    const draft = await prisma.reamonCodeDraft.findFirst({
      where: { id: draftId, projectId, codeUnitId: unitId, artifactId: resolved.artifactId, runKey: resolved.runKey },
      select: { id: true, sourceHash: true },
    })
    if (!draft) return NextResponse.json({ error: 'Code draft not found' }, { status: 404 })
    if (draft.sourceHash !== resolved.sourceHash) return NextResponse.json({ error: 'The original source changed. Create a new draft from the current decompilation.' }, { status: 409 })
    const updated = await prisma.reamonCodeDraft.update({
      where: { id: draft.id },
      data: { sourceCode, syntaxValidated: null, validationStatus: null, validationMethod: null, validationMessage: null },
      select: { id: true, updatedAt: true },
    })
    return NextResponse.json({ saved: true, draftId: updated.id, updatedAt: updated.updatedAt.toISOString() }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to update REAmon code draft:', error)
    return NextResponse.json({ error: 'Failed to update code draft' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

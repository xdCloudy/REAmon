import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { agentFetch } from '@/lib/agentFetch'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'
import { applySafeRenameBindings, listSafeRenameBindings } from '@/lib/reamon/webcrack'
import { buildProjectSymbolContext } from '@/lib/reamon/maintenance-memory'

interface RouteParams { params: Promise<{ id: string }> }

const MAX_SOURCE_BYTES = 512 * 1024
const MAX_SUGGESTION_SOURCE_BYTES = 64 * 1024
const MAX_CANDIDATES = 200
const MAX_PROJECT_SYMBOL_SCAN = 4_096

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function digest(source: Buffer): string {
  return createHash('sha256').update(source).digest('hex')
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    let rawBody: unknown
    try { rawBody = await request.json() } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })
    }
    const body = plainObject(rawBody)
    const operation = body.operation
    const unitId = typeof body.unitId === 'string' ? body.unitId.trim() : ''
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : ''
    if (!unitId || unitId.length > 128 || !['suggest', 'apply'].includes(String(operation))) {
      return NextResponse.json({ error: 'A code unit and safe-rename operation are required' }, { status: 400 })
    }

    const observation = await prisma.reamonObservation.findFirst({
      where: { id: unitId, projectId, type: 'code_unit' },
      select: { id: true, artifactId: true, taskId: true, label: true, attributes: true },
    })
    if (!observation?.artifactId) return NextResponse.json({ error: 'Code unit not found' }, { status: 404 })
    const attributes = plainObject(observation.attributes)
    const language = typeof attributes.language === 'string' ? attributes.language.trim() : ''
    if (!['javascript', 'typescript', 'jsx', 'tsx'].includes(language.toLowerCase())) {
      return NextResponse.json({ error: 'Scope-safe renaming currently supports JavaScript and TypeScript source only' }, { status: 415 })
    }
    const codeArtifactId = typeof attributes.codeArtifactId === 'string' ? attributes.codeArtifactId : ''
    const selection = await getActiveWorkspaceImportSelection(projectId)
    const artifact = await prisma.artifact.findFirst({
      where: { AND: [{ id: observation.artifactId, projectId }, selection.artifactWhere] },
      select: { id: true, sha256: true },
    })
    if (!artifact) return NextResponse.json({ error: 'Code unit is not part of the active workspace' }, { status: 404 })
    const prefix = `${projectId}/${artifact.id}/`
    const segments = codeArtifactId.split('/')
    if (!codeArtifactId.startsWith(prefix) || segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
      return NextResponse.json({ error: 'Code unit has no valid linked source artifact' }, { status: 404 })
    }
    const root = derivedArtifactRoot()
    const candidatePath = resolveDerivedArtifactPath(codeArtifactId)
    const [rootRealPath, sourceRealPath] = await Promise.all([realpath(root), realpath(candidatePath).catch(() => null)])
    if (!sourceRealPath || !isInside(rootRealPath, sourceRealPath)) return NextResponse.json({ error: 'Linked source path is invalid' }, { status: 404 })
    const info = await stat(sourceRealPath)
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return NextResponse.json({ error: 'Linked JavaScript source exceeds the safe-rename limit' }, { status: 413 })
    const sourceBytes = await readFile(sourceRealPath)
    const sourceCode = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes)
    const artifactSourceSha256 = digest(sourceBytes)
    const workingSource = typeof body.sourceCode === 'string' ? body.sourceCode : sourceCode
    const workingBytes = Buffer.from(workingSource, 'utf8')
    if (workingBytes.byteLength > MAX_SOURCE_BYTES) return NextResponse.json({ error: 'Editable JavaScript source exceeds the safe-rename limit' }, { status: 413 })
    const workingSourceSha256 = digest(workingBytes)
    const unitName = (typeof attributes.qualifiedName === 'string' && attributes.qualifiedName)
      || (typeof attributes.name === 'string' && attributes.name)
      || observation.label || 'Selected JavaScript unit'

    if (operation === 'suggest') {
      if (!providerId || providerId.length > 128) return NextResponse.json({ error: 'Choose a saved AI provider' }, { status: 400 })
      if (workingBytes.byteLength > MAX_SUGGESTION_SOURCE_BYTES) return NextResponse.json({ error: 'This source is too large for AI rename suggestions' }, { status: 413 })
      const provider = await prisma.userLlmProvider.findFirst({
        where: { id: providerId, userId: user.userId, providerType: 'openai_compatible' },
        select: { id: true, modelIdentifier: true },
      })
      if (!provider) return NextResponse.json({ error: 'Saved OpenAI-compatible provider not found' }, { status: 404 })

      const catalog = await listSafeRenameBindings(workingSource)
      const candidates = catalog.bindings
        .filter((binding) => !binding.exported && binding.kind !== 'module' && binding.referenceCount > 0
          && (binding.name.length <= 3 || /^_?(?:0x[\da-f]{4,}|[\da-f]{6,})$/i.test(binding.name)))
        .slice(0, MAX_CANDIDATES)
      if (!candidates.length) {
        return NextResponse.json({ sourceSha256: workingSourceSha256, providerId: provider.id, providerName: 'REAmon scope-safe renames', model: provider.modelIdentifier, candidates: 0, renames: [] }, { headers: { 'Cache-Control': 'private, no-store' } })
      }

      const scannedSymbolRows = await prisma.reamonMaintainedSource.findMany({
        where: { projectId },
        select: { codeUnitId: true, artifactId: true, unitName: true, language: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true },
        orderBy: { updatedAt: 'desc' },
        take: MAX_PROJECT_SYMBOL_SCAN + 1,
      })
      const projectSymbolScanTruncated = scannedSymbolRows.length > MAX_PROJECT_SYMBOL_SCAN
      const symbolRows = scannedSymbolRows.slice(0, MAX_PROJECT_SYMBOL_SCAN)
      const reviewIds = [...new Set(symbolRows.flatMap((row) => row.acceptedReviewId ? [row.acceptedReviewId] : []))]
      const reviews = reviewIds.length ? await prisma.reamonCodeReview.findMany({
        where: { projectId, id: { in: reviewIds }, decision: 'ACCEPTED' },
        select: { id: true, artifactId: true, codeUnitId: true, maintainedSourceHash: true, validationStatus: true, validationMethod: true },
      }) : []
      const reviewById = new Map(reviews.map((review) => [review.id, review]))
      const trustedRows = symbolRows.filter((row) => {
        if (!row.acceptedReviewId || !row.sourceHash) return false
        const receipt = reviewById.get(row.acceptedReviewId)
        return receipt?.artifactId === row.artifactId
          && receipt.codeUnitId === row.codeUnitId
          && receipt.maintainedSourceHash === row.sourceHash
      })
      const artifactIds = [...new Set(trustedRows.map((row) => row.artifactId))]
      const artifacts = artifactIds.length ? await prisma.artifact.findMany({
        where: { projectId, id: { in: artifactIds } },
        select: { id: true, originalName: true, sha256: true },
      }) : []
      const artifactById = new Map(artifacts.map((row) => [row.id, row]))
      const projectSymbolContext = buildProjectSymbolContext(trustedRows.map((row) => {
        const receipt = row.acceptedReviewId ? reviewById.get(row.acceptedReviewId) : undefined
        return {
          ...row,
          artifactName: artifactById.get(row.artifactId)?.originalName,
          artifactHash: artifactById.get(row.artifactId)?.sha256,
          validationStatus: receipt?.validationStatus,
          validationMethod: receipt?.validationMethod,
        }
      }), new Set(), 6_000, artifact.sha256 || undefined, undefined, projectSymbolScanTruncated)
      const response = await agentFetch('/reamon/code/suggest-renames', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `custom/${provider.id}`,
          user_id: user.userId,
          unit_name: unitName,
          source_code: workingSource,
          bindings: candidates,
          project_symbol_context: projectSymbolContext,
          question: typeof body.question === 'string' ? body.question.slice(0, 1000) : '',
        }),
      }, { timeoutMs: 120_000 })
      const result = await response.json().catch(() => null) as { renames?: unknown; error?: string } | null
      if (!response.ok || !result || !Array.isArray(result.renames)) {
        return NextResponse.json({ error: result?.error || 'Could not generate rename suggestions' }, { status: response.status || 502 })
      }
      const allowedIds = new Set(candidates.map((candidate) => candidate.id))
      const renames = result.renames.filter((rename): rename is Record<string, unknown> => Boolean(rename && typeof rename === 'object' && !Array.isArray(rename)))
        .filter((rename) => typeof rename.bindingId === 'string' && allowedIds.has(rename.bindingId)
          && typeof rename.oldName === 'string' && typeof rename.newName === 'string'
          && typeof rename.rationale === 'string')
        .slice(0, 80)
      return NextResponse.json({
        sourceSha256: workingSourceSha256,
        providerId: provider.id,
        providerName: 'REAmon scope-safe renames',
        model: provider.modelIdentifier,
        candidates: candidates.length,
        renames,
      }, { headers: { 'Cache-Control': 'private, no-store' } })
    }

    const expectedSha256 = typeof body.expectedSha256 === 'string' ? body.expectedSha256.toLowerCase() : ''
    if (expectedSha256 !== workingSourceSha256) return NextResponse.json({ error: 'The source changed after rename suggestions were generated. Reload and retry.' }, { status: 409 })
    if (!providerId || providerId.length > 128) return NextResponse.json({ error: 'Choose the saved provider used for rename suggestions' }, { status: 400 })
    const provider = await prisma.userLlmProvider.findFirst({
      where: { id: providerId, userId: user.userId, providerType: 'openai_compatible' },
      select: { id: true, name: true, modelIdentifier: true },
    })
    if (!provider) return NextResponse.json({ error: 'Saved OpenAI-compatible provider not found' }, { status: 404 })
    const requests = Array.isArray(body.renames) ? body.renames : []
    if (requests.length < 1 || requests.length > 80) return NextResponse.json({ error: 'Select between 1 and 80 rename suggestions' }, { status: 400 })
    const catalog = await listSafeRenameBindings(workingSource)
    const available = new Map(catalog.bindings.map((binding) => [binding.id, binding]))
    for (const rename of requests) {
      const item = plainObject(rename)
      const binding = typeof item.bindingId === 'string' ? available.get(item.bindingId) : undefined
      if (!binding || binding.exported || typeof item.newName !== 'string' || item.oldName !== binding.name
          || typeof item.rationale !== 'string' || item.rationale.length > 400) {
        return NextResponse.json({ error: 'A selected rename no longer matches the current source bindings' }, { status: 409 })
      }
    }
    const transformed = await applySafeRenameBindings(workingSource, workingSourceSha256, requests.map((rename) => {
      const item = plainObject(rename)
      return { bindingId: String(item.bindingId), newName: String(item.newName) }
    }))
    const runKey = segments.slice(0, 4).join('/')
    const validationMethod = `babel-parser-${transformed.parserVersion}+scope-safe-rename`
    const validationMessage = `Babel ${transformed.parserVersion} parsed the output after scope-aware renaming and rejected binding collisions. This confirms syntax only, not behavior equivalence.`
    const attempt = await prisma.reamonCodeAttempt.create({
      data: {
        projectId,
        ownerUserId: user.userId,
        artifactId: artifact.id,
        runKey,
        codeUnitId: observation.id,
        unitName: unitName.slice(0, 500),
        language,
        sourceHash: artifactSourceSha256,
        providerName: 'REAmon scope-safe renames',
        modelIdentifier: provider.modelIdentifier.slice(0, 128),
        question: 'Apply accepted evidence-backed identifier rename proposals',
        scope: 'file',
        status: 'SUCCEEDED',
        requestPayload: {
          operation: 'humanify-style-scope-safe-renames',
          engine: `Babel ${transformed.parserVersion} scope.rename (Humanify two-stage design)`,
          inputSha256: workingSourceSha256,
          artifactSourceSha256,
          inputSource: workingSource,
          outputSha256: transformed.outputSha256,
          renames: transformed.renamedBindings.map((binding) => ({
            ...binding,
            rationale: String(plainObject(requests.find((rename) => plainObject(rename).bindingId === binding.bindingId)).rationale || '').slice(0, 400),
          })),
        },
        resultSource: transformed.sourceCode,
        syntaxValidated: true,
        validationStatus: 'PASSED',
        validationMethod,
        validationMessage,
        completedAt: new Date(),
      },
      select: { id: true },
    })
    return NextResponse.json({
      sourceCode: transformed.sourceCode,
      sourceSha256: workingSourceSha256,
      outputSha256: transformed.outputSha256,
      renamedBindings: transformed.renamedBindings,
      attemptId: attempt.id,
      providerName: 'REAmon scope-safe renames',
      model: provider.modelIdentifier,
      syntaxValidated: true,
      validationStatus: 'PASSED',
      validationMethod,
      validationMessage,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to apply REAmon safe renames:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message.slice(0, 500) : 'Could not process safe rename request' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

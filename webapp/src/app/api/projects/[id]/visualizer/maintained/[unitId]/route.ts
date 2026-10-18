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
import { extractAcceptedRenameAliases, extractMaintainedSymbols } from '@/lib/reamon/maintenance-memory'
import { validateJavaScriptSource } from '@/lib/reamon/webcrack'
import { isValidationRegression } from '@/lib/reamon/validation-regression'

interface RouteParams { params: Promise<{ id: string; unitId: string }> }
const MAX_SOURCE_BYTES = 2 * 1024 * 1024

class MaintainedSourceConflict extends Error {}
class MaintainedSourceValidationRegression extends Error {}

interface MaintainedSourceValidation {
  source_sha256: string
  validation_status: 'PASSED' | 'FAILED' | 'UNAVAILABLE'
  validation_method: string | null
  validation_message: string
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

async function maintainedSourceIndex(sourceCode: string, language: string): Promise<{
  symbols: string[]
  members: Array<{ name: string; kind: string; line: number; startByte: number; endByte: number }>
  truncated: boolean
  parserVersion: string | null
}> {
  try {
    const response = await agentFetch('/reamon/code/index-symbols', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_code: sourceCode, language }),
    }, { timeoutMs: 5_000 })
    if (response.ok) {
      const result = await response.json().catch(() => null) as {
        indexed?: boolean
        symbols?: unknown
        members?: unknown
        truncated?: unknown
        parserVersion?: unknown
      } | null
      if (result?.indexed === true && Array.isArray(result.symbols)) {
        const members = Array.isArray(result.members) ? result.members.flatMap((value) => {
          const member = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
          if (typeof member.name !== 'string' || !member.name || member.name.length > 256
              || typeof member.kind !== 'string' || !member.kind || member.kind.length > 80
              || !Number.isSafeInteger(member.line) || !Number.isSafeInteger(member.start_byte)
              || !Number.isSafeInteger(member.end_byte) || (member.start_byte as number) < 0
              || (member.end_byte as number) < (member.start_byte as number)) return []
          return [{
            name: member.name,
            kind: member.kind,
            line: member.line as number,
            startByte: member.start_byte as number,
            endByte: member.end_byte as number,
          }]
        }).slice(0, 10_000) : []
        return {
          symbols: [...new Set(result.symbols.filter((symbol): symbol is string => typeof symbol === 'string' && symbol.length > 1 && symbol.length <= 128))].slice(0, 512),
          members,
          truncated: result.truncated === true || (Array.isArray(result.members) && result.members.length > 10_000),
          parserVersion: typeof result.parserVersion === 'string' ? result.parserVersion.slice(0, 80) : null,
        }
      }
    }
  } catch {
    // Saving maintained source stays available when the optional parser service is down.
  }
  return { symbols: extractMaintainedSymbols(sourceCode, language), members: [], truncated: false, parserVersion: null }
}

async function acceptedSafeRenameAliases(
  projectId: string,
  artifactId: string,
  runKey: string,
  unitId: string,
  sourceCode: string,
  sourceHash: string,
): Promise<Array<{ bindingId: string; oldName: string; newName: string; kind: string }>> {
  try {
    const attempts = await prisma.reamonCodeAttempt.findMany({
      where: { projectId, artifactId, runKey, codeUnitId: unitId, status: 'SUCCEEDED', resultSource: sourceCode },
      select: { resultSource: true, requestPayload: true, validationStatus: true },
      take: 20,
    })
    for (const attempt of attempts) {
      if (attempt.validationStatus !== 'PASSED' || attempt.resultSource !== sourceCode
          || createHash('sha256').update(attempt.resultSource).digest('hex') !== sourceHash) continue
      const payload = plainObject(attempt.requestPayload)
      const goBindings = payload.operation === 'go-types-scope-safe-renames'
      const rustBindings = payload.operation === 'rust-analyzer-rust-lsp-semantic-local-renames'
      const luaBindings = payload.operation === 'luals-scope-safe-renames'
      const csharpBindings = payload.operation === 'roslyn-csharp-scope-safe-renames'
      const javaBindings = payload.operation === 'javac-java-scope-safe-renames'
      const phpBindings = payload.operation === 'phpactor-php-lsp-scope-safe-renames'
      const rubyBindings = payload.operation === 'solargraph-ruby-semantic-local-renames'
      if (!['humanify-style-scope-safe-renames', 'libcst-scope-safe-renames', 'go-types-scope-safe-renames', 'rust-analyzer-rust-lsp-semantic-local-renames', 'luals-scope-safe-renames', 'roslyn-csharp-scope-safe-renames', 'javac-java-scope-safe-renames', 'phpactor-php-lsp-scope-safe-renames', 'solargraph-ruby-semantic-local-renames'].includes(String(payload.operation))
          || payload.outputSha256 !== sourceHash || !Array.isArray(payload.renames)) continue
      const aliases = payload.renames.flatMap((value) => {
        const rename = plainObject(value)
        const validName = (name: string) => rubyBindings
          ? /^[a-z_][A-Za-z0-9_]{0,127}$/.test(name)
          : phpBindings
          ? /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
          : javaBindings
          ? /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(name)
          : csharpBindings
            ? /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
            : goBindings || rustBindings
          ? /^[_\p{ID_Start}][\p{ID_Continue}]*$/u.test(name)
          : luaBindings
            ? /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) && !new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']).has(name)
            : /^[A-Za-z_$][\w$]{0,127}$/.test(name)
        if (typeof rename.oldName !== 'string' || typeof rename.newName !== 'string'
            || typeof rename.bindingId !== 'string' || !/^[a-f0-9]{24}$/i.test(rename.bindingId)
            || typeof rename.kind !== 'string' || rename.kind.length > 80
            || !validName(rename.oldName) || !validName(rename.newName)
            || rename.oldName === rename.newName) return []
        return [{ bindingId: rename.bindingId.toLowerCase(), oldName: rename.oldName, newName: rename.newName, kind: rename.kind }]
      }).slice(0, 200)
      return aliases
    }
  } catch (error) {
    console.error('Could not load accepted scope-safe rename lineage:', error)
  }
  return []
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
  return { projectId, unitId, reviewerId: user.userId, observation, attributes, artifactId: artifact.id, runKey: segments.slice(0, 4).join('/'), originalPath, relativePath } as const
}

async function checkedPath(relativePath: string) {
  const root = derivedArtifactRoot()
  const absolute = resolveDerivedArtifactPath(relativePath)
  const [rootRealPath, fileRealPath] = await Promise.all([realpath(root), realpath(absolute).catch(() => null)])
  if (fileRealPath && !isInside(rootRealPath, fileRealPath)) throw new Error('Maintained source path is invalid')
  return { rootRealPath, absolute, fileRealPath }
}

async function sourceArtifactHash(relativePath: string): Promise<string | null> {
  try {
    const { fileRealPath } = await checkedPath(relativePath)
    if (!fileRealPath) return null
    const info = await stat(fileRealPath)
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return null
    return createHash('sha256').update(await readFile(fileRealPath)).digest('hex')
  } catch {
    return null
  }
}

async function validateMaintainedSource(sourceCode: string, language: string): Promise<MaintainedSourceValidation> {
  const sourceHash = createHash('sha256').update(sourceCode).digest('hex')
  const unavailable = (message: string): MaintainedSourceValidation => ({
    source_sha256: sourceHash,
    validation_status: 'UNAVAILABLE',
    validation_method: null,
    validation_message: message,
  })
  const normalizedLanguage = language.trim().toLowerCase()
  const babelLanguages = new Set(['javascript', 'javascript source', 'ecmascript', 'js', 'jsx', 'mjs', 'cjs', 'typescript', 'typescript source', 'ts', 'tsx'])
  if (babelLanguages.has(normalizedLanguage) && Buffer.byteLength(sourceCode, 'utf8') <= 512 * 1024) {
    try {
      const result = await validateJavaScriptSource(sourceCode)
      if (result.sourceSha256 !== sourceHash) return unavailable('The JavaScript parser returned a result for a different source version.')
      return {
        source_sha256: sourceHash,
        validation_status: result.validationStatus,
        validation_method: `babel-parser-${result.parserVersion}`,
        validation_message: result.validationMessage,
      }
    } catch {
      // Preserve the broader Tree-sitter fallback when Babel is unavailable.
    }
  }
  try {
    const response = await agentFetch('/reamon/code/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_code: sourceCode, language }),
    }, { timeoutMs: 20_000 })
    if (!response.ok) return unavailable('The source validation service could not validate this accepted source.')
    const result = await response.json().catch(() => null) as Partial<MaintainedSourceValidation> | null
    if (!result || result.source_sha256 !== sourceHash
        || !['PASSED', 'FAILED', 'UNAVAILABLE'].includes(String(result.validation_status))) {
      return unavailable('The source validation service returned an incomplete or mismatched result.')
    }
    return {
      source_sha256: sourceHash,
      validation_status: result.validation_status as MaintainedSourceValidation['validation_status'],
      validation_method: typeof result.validation_method === 'string' ? result.validation_method.slice(0, 80) : null,
      validation_message: typeof result.validation_message === 'string' ? result.validation_message.slice(0, 2000) : 'No validation message was returned.',
    }
  } catch {
    return unavailable('The source validation service is unavailable; syntax validation was not recorded.')
  }
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, unitId } = await params
    const resolved = await resolveUnit(projectId, unitId)
    if ('response' in resolved) return resolved.response
    const { absolute, fileRealPath } = await checkedPath(resolved.relativePath)
    const revisionId = new URL(request.url).searchParams.get('revision')
    if (revisionId) {
      if (revisionId.length > 128) return NextResponse.json({ error: 'Invalid accepted source revision' }, { status: 400 })
      const revision = await prisma.reamonCodeReview.findFirst({
        where: { id: revisionId, projectId, artifactId: resolved.artifactId, codeUnitId: unitId, decision: 'ACCEPTED' },
        select: { id: true, maintainedSourceHash: true, sourceSnapshot: true, createdAt: true },
      })
      if (!revision?.sourceSnapshot) {
        return NextResponse.json({ error: 'This accepted source predates version snapshots or its source is unavailable.' }, { status: 404 })
      }
      if (Buffer.byteLength(revision.sourceSnapshot, 'utf8') > MAX_SOURCE_BYTES
          || createHash('sha256').update(revision.sourceSnapshot).digest('hex') !== revision.maintainedSourceHash) {
        return NextResponse.json({ error: 'The saved accepted source snapshot failed its integrity check.' }, { status: 409 })
      }
      return NextResponse.json({
        sourceCode: revision.sourceSnapshot,
        sourceHash: revision.maintainedSourceHash,
        revisionId: revision.id,
        createdAt: revision.createdAt.toISOString(),
      }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    const [savedSource, reviews, restorableReviews] = await Promise.all([
      prisma.reamonMaintainedSource.findUnique({
        where: { projectId_codeUnitId: { projectId, codeUnitId: unitId } },
        select: { sourceCode: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true, updatedAt: true },
      }),
      prisma.reamonCodeReview.findMany({
        where: { projectId, codeUnitId: unitId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, reviewerId: true, decision: true, rationale: true, maintainedSourceHash: true, validationStatus: true, validationMethod: true, validationMessage: true, createdAt: true },
      }),
      prisma.reamonCodeReview.findMany({
        where: { projectId, artifactId: resolved.artifactId, codeUnitId: unitId, decision: 'ACCEPTED', sourceSnapshot: { not: null } },
        orderBy: { createdAt: 'desc' }, take: 10, select: { id: true },
      }),
    ])
    const restorableReviewIds = new Set(restorableReviews.map((review) => review.id))
    const reviewHistory = reviews.map((review) => ({
      ...review,
      sourceAvailable: restorableReviewIds.has(review.id),
      createdAt: review.createdAt.toISOString(),
    }))
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
      const sourceHash = createHash('sha256').update(savedSource.sourceCode).digest('hex')
      const acceptedReceipt = savedSource.acceptedReviewId ? await prisma.reamonCodeReview.findFirst({
        where: {
          id: savedSource.acceptedReviewId,
          projectId,
          artifactId: resolved.artifactId,
          codeUnitId: unitId,
          decision: 'ACCEPTED',
          maintainedSourceHash: sourceHash,
        },
        select: { id: true, symbolIndexSnapshot: true },
      }) : null
      const acceptedRenameAliases = acceptedReceipt && savedSource.sourceHash === sourceHash
        ? extractAcceptedRenameAliases(acceptedReceipt.symbolIndexSnapshot)
        : []
      const storedLineage = plainObject(plainObject(acceptedReceipt?.symbolIndexSnapshot).sourceLineage)
      const baseSourceHash = typeof storedLineage.baseSourceHash === 'string'
          && /^[a-f0-9]{64}$/i.test(storedLineage.baseSourceHash)
        ? storedLineage.baseSourceHash.toLowerCase()
        : null
      const currentSourceHash = await sourceArtifactHash(resolved.originalPath)
      const baselineStatus = baseSourceHash
        ? currentSourceHash === null ? 'UNAVAILABLE' : currentSourceHash === baseSourceHash ? 'CURRENT' : 'CHANGED'
        : 'UNRECORDED'
      let baseSourceCode: string | null = null
      const baseSourcePath = typeof storedLineage.baseSourcePath === 'string' && storedLineage.baseSourcePath.length <= 2_000 ? storedLineage.baseSourcePath : ''
      const baseRunKey = typeof storedLineage.runKey === 'string' && storedLineage.runKey.length <= 500 ? storedLineage.runKey : ''
      const expectedArtifactPrefix = `${projectId}/${resolved.artifactId}/`
      const sourcePathSuffix = resolved.originalPath.split('/').slice(4).join('/')
      const candidateBasePaths = [...new Set([
        baseSourcePath,
        baseRunKey && sourcePathSuffix ? `${baseRunKey}/${sourcePathSuffix}` : '',
      ].filter(Boolean))]
      if (baselineStatus === 'CHANGED' && baseSourceHash && baseRunKey) {
        for (const candidatePath of candidateBasePaths) {
          if (!candidatePath.startsWith(`${baseRunKey}/`)
              || !candidatePath.startsWith(expectedArtifactPrefix)
              || candidatePath.length > 2_000
              || candidatePath.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) continue
          try {
            const { fileRealPath } = await checkedPath(candidatePath)
            if (fileRealPath) {
              const info = await stat(fileRealPath)
              if (info.isFile() && info.size <= MAX_SOURCE_BYTES) {
                const bytes = await readFile(fileRealPath)
                if (createHash('sha256').update(bytes).digest('hex') === baseSourceHash) {
                  baseSourceCode = bytes.toString('utf8')
                  break
                }
              }
            }
          } catch {
            continue
          }
        }
      }
      return NextResponse.json({
        exists: true,
        sourceCode: savedSource.sourceCode,
        sourceHash,
        acceptedReviewId: acceptedReceipt?.id ?? null,
        updatedAt: savedSource.updatedAt.toISOString(),
        reviews: reviewHistory,
        acceptedRenameAliases,
        sourceLineage: {
          baseSourceHash,
          baseRunKey: baseRunKey ? baseRunKey.slice(0, 500) : null,
          currentSourceHash,
          baselineStatus,
          baseSourceCode,
        },
      }, { headers: { 'Cache-Control': 'private, no-store' } })
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

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, unitId } = await params
    const resolved = await resolveUnit(projectId, unitId)
    if ('response' in resolved) return resolved.response
    const body = plainObject(await request.json().catch(() => null))
    const sourceCode = body.sourceCode
    const reviewRationale = typeof body.reviewRationale === 'string' ? body.reviewRationale.trim() : ''
    if (typeof sourceCode !== 'string' || !sourceCode.trim()) return NextResponse.json({ error: 'Rejected draft source cannot be empty' }, { status: 400 })
    if (Buffer.byteLength(sourceCode, 'utf8') > MAX_SOURCE_BYTES) return NextResponse.json({ error: 'Rejected draft exceeds the save limit' }, { status: 413 })
    if (reviewRationale.length < 12 || reviewRationale.length > 1000) {
      return NextResponse.json({ error: 'Add a review rationale between 12 and 1000 characters before rejecting this draft.' }, { status: 400 })
    }

    const rejectedSourceHash = createHash('sha256').update(sourceCode).digest('hex')
    const savedDraft = await prisma.reamonCodeDraft.findFirst({
      where: {
        projectId,
        artifactId: resolved.artifactId,
        runKey: resolved.runKey,
        codeUnitId: unitId,
        draftHash: rejectedSourceHash,
      },
      select: { id: true },
    })
    if (!savedDraft) return NextResponse.json({ error: 'Save this exact draft to project memory before recording its rejection.' }, { status: 409 })

    const currentMaintainedSource = await prisma.reamonMaintainedSource.findUnique({
      where: { projectId_codeUnitId: { projectId, codeUnitId: unitId } },
      select: { sourceCode: true, acceptedReviewId: true },
    })
    if (currentMaintainedSource?.acceptedReviewId
        && createHash('sha256').update(currentMaintainedSource.sourceCode).digest('hex') === rejectedSourceHash) {
      return NextResponse.json({ error: 'This exact source version is already accepted. Edit it before recording a rejection.' }, { status: 409 })
    }

    const review = await prisma.reamonCodeReview.create({
      data: {
        projectId,
        artifactId: resolved.artifactId,
        codeUnitId: unitId,
        reviewerId: resolved.reviewerId,
        decision: 'REJECTED',
        rationale: reviewRationale,
        maintainedSourceHash: rejectedSourceHash,
      },
      select: { id: true, reviewerId: true, decision: true, rationale: true, maintainedSourceHash: true, createdAt: true },
    })
    return NextResponse.json({ saved: true, review: { ...review, createdAt: review.createdAt.toISOString() } }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to record rejected REAmon draft:', error)
    return NextResponse.json({ error: 'Failed to record rejected draft' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, unitId } = await params
    const resolved = await resolveUnit(projectId, unitId)
    if ('response' in resolved) return resolved.response
    const body = plainObject(await request.json().catch(() => null))
    const expectedSourceHash = typeof body.expectedSourceHash === 'string' && /^[a-f0-9]{64}$/i.test(body.expectedSourceHash)
      ? body.expectedSourceHash.toLowerCase()
      : ''
    const rationale = typeof body.reviewRationale === 'string' ? body.reviewRationale.trim() : ''
    if (!expectedSourceHash) return NextResponse.json({ error: 'A valid expected source hash is required to revoke acceptance.' }, { status: 400 })
    if (rationale.length < 12 || rationale.length > 1000) {
      return NextResponse.json({ error: 'Add a revocation rationale between 12 and 1000 characters.' }, { status: 400 })
    }

    const review = await prisma.$transaction(async (tx) => {
      const currentSource = await tx.reamonMaintainedSource.findUnique({
        where: { projectId_codeUnitId: { projectId, codeUnitId: unitId } },
        select: { sourceCode: true, sourceHash: true, acceptedReviewId: true },
      })
      if (!currentSource?.acceptedReviewId) throw new MaintainedSourceConflict()
      const sourceHash = createHash('sha256').update(currentSource.sourceCode).digest('hex')
      if (sourceHash !== expectedSourceHash) throw new MaintainedSourceConflict()
      const acceptedReceipt = await tx.reamonCodeReview.findFirst({
        where: {
          id: currentSource.acceptedReviewId,
          projectId,
          artifactId: resolved.artifactId,
          codeUnitId: unitId,
          decision: 'ACCEPTED',
          maintainedSourceHash: sourceHash,
        },
        select: { id: true },
      })
      if (!acceptedReceipt) throw new MaintainedSourceConflict()

      const revokedReceipt = await tx.reamonCodeReview.create({
        data: {
          projectId,
          artifactId: resolved.artifactId,
          codeUnitId: unitId,
          reviewerId: resolved.reviewerId,
          decision: 'REVOKED',
          rationale,
          maintainedSourceHash: sourceHash,
        },
        select: { id: true, reviewerId: true, decision: true, rationale: true, maintainedSourceHash: true, createdAt: true },
      })
      const updated = await tx.reamonMaintainedSource.updateMany({
        where: { projectId, codeUnitId: unitId, sourceHash: currentSource.sourceHash, acceptedReviewId: acceptedReceipt.id },
        data: { acceptedReviewId: null },
      })
      if (updated.count !== 1) throw new MaintainedSourceConflict()
      return revokedReceipt
    })
    return NextResponse.json({ revoked: true, review: { ...review, createdAt: review.createdAt.toISOString() } }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof MaintainedSourceConflict || isUniqueConflict(error)) {
      return NextResponse.json({ error: 'The accepted source changed after you opened it. Reload and review the current version before revoking it.' }, { status: 409 })
    }
    console.error('Failed to revoke maintained REAmon source:', error)
    return NextResponse.json({ error: 'Failed to revoke maintained source acceptance' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
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
    const restoreReviewId = requestBody.restoreReviewId === undefined || requestBody.restoreReviewId === null
      ? null
      : typeof requestBody.restoreReviewId === 'string' && requestBody.restoreReviewId.length <= 128
        ? requestBody.restoreReviewId
        : ''
    const reviewRationale = typeof requestBody.reviewRationale === 'string' ? requestBody.reviewRationale.trim() : ''
    if (typeof sourceCode !== 'string' || !sourceCode.trim()) return NextResponse.json({ error: 'Maintained source cannot be empty' }, { status: 400 })
    if (Buffer.byteLength(sourceCode, 'utf8') > MAX_SOURCE_BYTES) return NextResponse.json({ error: 'Maintained source exceeds the save limit' }, { status: 413 })
    if (reviewRationale.length < 12 || reviewRationale.length > 1000) {
      return NextResponse.json({ error: 'Add a review rationale between 12 and 1000 characters before accepting this source.' }, { status: 400 })
    }
    if (expectedSourceHash === '') return NextResponse.json({ error: 'The maintained source version is invalid. Reload it before accepting changes.' }, { status: 400 })
    if (restoreReviewId === '') return NextResponse.json({ error: 'The accepted source revision is invalid. Reload it before accepting changes.' }, { status: 400 })

    const original = await checkedPath(resolved.originalPath)
    let baseSourceHash: string | null = null
    if (original.fileRealPath) {
      const originalInfo = await stat(original.fileRealPath)
      if (originalInfo.isFile() && originalInfo.size <= MAX_SOURCE_BYTES) {
        const originalBytes = await readFile(original.fileRealPath)
        baseSourceHash = createHash('sha256').update(originalBytes).digest('hex')
        const originalSource = originalBytes.toString('utf8')
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
    const dialect = typeof attributes.dialect === 'string' ? attributes.dialect.toLowerCase() : ''
    const validationLanguage = language.trim().toLowerCase() === 'lua' && /^lua5\.[1-5]$/.test(dialect)
      ? `Lua ${dialect.slice(3)}`
      : language
    const now = new Date().toISOString()
    const { rootRealPath, absolute } = await checkedPath(resolved.relativePath)
    const maintainedSourceHash = createHash('sha256').update(sourceCode).digest('hex')
    const [sourceIndex, currentSource, newAliases, restoredReview] = await Promise.all([
      maintainedSourceIndex(sourceCode, language),
      prisma.reamonMaintainedSource.findUnique({
        where: { projectId_codeUnitId: { projectId, codeUnitId: resolved.unitId } },
        select: { sourceCode: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true },
      }),
      acceptedSafeRenameAliases(projectId, resolved.artifactId, resolved.runKey, resolved.unitId, sourceCode, maintainedSourceHash),
      restoreReviewId
        ? prisma.reamonCodeReview.findFirst({
          where: { id: restoreReviewId, projectId, artifactId: resolved.artifactId, codeUnitId: resolved.unitId, decision: 'ACCEPTED' },
          select: { maintainedSourceHash: true, sourceSnapshot: true, symbolIndexSnapshot: true },
        })
        : Promise.resolve(null),
    ])
    if (restoreReviewId && (!restoredReview?.sourceSnapshot
        || Buffer.byteLength(restoredReview.sourceSnapshot, 'utf8') > MAX_SOURCE_BYTES
        || createHash('sha256').update(restoredReview.sourceSnapshot).digest('hex') !== restoredReview.maintainedSourceHash)) {
      return NextResponse.json({ error: 'The selected accepted source revision is unavailable or failed its integrity check. Reload a verified revision before accepting.' }, { status: 409 })
    }
    const currentSourceHash = currentSource
      ? createHash('sha256').update(currentSource.sourceCode).digest('hex')
      : null
    const acceptedSourceReceipt = currentSource?.acceptedReviewId && currentSourceHash
      ? await prisma.reamonCodeReview.findFirst({
        where: {
          id: currentSource.acceptedReviewId,
          projectId,
          artifactId: resolved.artifactId,
          codeUnitId: resolved.unitId,
          decision: 'ACCEPTED',
          maintainedSourceHash: currentSourceHash,
        },
        select: { id: true, symbolIndexSnapshot: true },
      })
      : null
    const previousAliases = restoredReview
      ? restoredReview.symbolIndexSnapshot
        ? extractAcceptedRenameAliases(restoredReview.symbolIndexSnapshot)
        : []
      : acceptedSourceReceipt && currentSource?.sourceHash === currentSourceHash
        ? extractAcceptedRenameAliases(acceptedSourceReceipt.symbolIndexSnapshot)
        : []
    const aliasesByLineage = new Map<string, (typeof newAliases)[number]>()
    for (const alias of [...previousAliases, ...newAliases]) {
      aliasesByLineage.set(`${alias.bindingId}\u0000${alias.oldName}\u0000${alias.newName}\u0000${alias.kind}`, alias)
    }
    const aliases = [...aliasesByLineage.values()].slice(-200)
    const symbolIndex = {
      ...sourceIndex,
      aliases,
      sourceLineage: { baseSourceHash, runKey: resolved.runKey, baseSourcePath: resolved.originalPath },
    }
    const validation = await validateMaintainedSource(sourceCode, validationLanguage)
    if (validation.validation_status === 'FAILED') {
      return NextResponse.json({
        error: 'The maintained source has syntax errors and was not accepted.',
        validationStatus: validation.validation_status,
        validationMethod: validation.validation_method,
        validationMessage: validation.validation_message,
      }, { status: 422 })
    }
    if (await sourceArtifactHash(resolved.originalPath) !== baseSourceHash) {
      return NextResponse.json({ error: 'The decompiler output changed while this maintained source was being reviewed. Reload the code unit and review it against the current output.' }, { status: 409 })
    }
    const review = await prisma.$transaction(async (tx) => {
      const currentSource = await tx.reamonMaintainedSource.findUnique({
        where: { projectId_codeUnitId: { projectId, codeUnitId: resolved.unitId } },
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
            artifactId: resolved.artifactId,
            codeUnitId: resolved.unitId,
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
          validationStatus: validation.validation_status,
          validationMethod: validation.validation_method,
          validationMessage: validation.validation_message,
          sourceSnapshot: sourceCode,
          symbolIndexSnapshot: symbolIndex,
        },
        select: { id: true, reviewerId: true, decision: true, rationale: true, maintainedSourceHash: true, validationStatus: true, validationMethod: true, validationMessage: true, createdAt: true },
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
    if (error instanceof MaintainedSourceValidationRegression) {
      return NextResponse.json({ error: 'This code unit has an accepted source with stronger validation evidence. The new source used a weaker validator or could not be validated, so the accepted source was kept unchanged.' }, { status: 503 })
    }
    if (error instanceof MaintainedSourceConflict || isUniqueConflict(error)) {
      return NextResponse.json({ error: 'The maintained source changed after you opened it. Reload the current version and review it before saving again.' }, { status: 409 })
    }
    console.error('Failed to save maintained REAmon source:', error)
    return NextResponse.json({ error: 'Failed to save maintained source' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

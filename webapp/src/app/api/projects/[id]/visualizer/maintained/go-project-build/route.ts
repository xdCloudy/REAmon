import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { agentFetch } from '@/lib/agentFetch'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { resolveArtifactStoragePath } from '@/lib/reamon/artifact-storage'
import { getVerifiedGoProjectBuildReceipt } from '@/lib/reamon/go-project-build-receipt'
import { CODE_UNIT_OBSERVATION_TYPE } from '@/lib/reamon/code-units'

interface RouteParams { params: Promise<{ id: string }> }
const MAX_INVENTORY_UNITS = 5000
const MAX_BUILD_FILES = 64
const MAX_BUILD_BYTES = 8 * 1024 * 1024
const MAX_SOURCE_BYTES = 512 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const BUILD_SOURCE = 'reamon-maintained-build'

interface SourceInput {
  unitId: string
  reviewId: string
  relativePath: string
  buildPath: string
  sourceCode: string
  sourceHash: string
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function setHash(files: Array<{ path: string; sourceHash: string }>): string {
  const ordered = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const hash = createHash('sha256')
  for (const file of ordered) hash.update(file.path).update('\0').update(file.sourceHash).update('\n')
  return hash.digest('hex')
}

function goLanguage(value: unknown): boolean {
  return typeof value === 'string' && ['go', 'golang', 'go source'].includes(value.trim().toLowerCase())
}

function safeGoPath(value: string): string | null {
  if (!value || value.length > 200 || value.includes('\\') || value.startsWith('/')
      || !/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(value)
      || value.split('/').some((part) => !part || part === '.' || part === '..')
      || !value.endsWith('.go')) return null
  return value
}

function moduleRoot(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized === 'go.mod' ? '' : normalized.slice(0, -'/go.mod'.length)
}

function pathUnder(path: string, root: string): boolean {
  return !root || path.startsWith(`${root}/`)
}

class GoBuildInputError extends Error {
  status: number
  constructor(message: string, status = 409) { super(message); this.status = status }
}

async function readManifest(artifact: { storagePath: string; sizeBytes: bigint; sha256: string }, label: string): Promise<string> {
  if (artifact.sizeBytes > BigInt(MAX_MANIFEST_BYTES)) throw new GoBuildInputError(`${label} exceeds the 1 MiB manifest limit.`, 413)
  const bytes = await readFile(resolveArtifactStoragePath(artifact.storagePath))
  if (bytes.length !== Number(artifact.sizeBytes) || sha256(bytes) !== artifact.sha256.toLowerCase()) {
    throw new GoBuildInputError(`${label} changed or no longer matches the imported workspace; reimport it before building.`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new GoBuildInputError(`${label} is not valid UTF-8 text.`)
  }
}

async function loadModuleManifests(
  artifactWhere: Prisma.ArtifactWhereInput,
  sourcePaths: string[],
) {
  const candidates = await prisma.artifact.findMany({
    where: { ...artifactWhere, relativePath: { endsWith: 'go.mod', mode: 'insensitive' } },
    orderBy: [{ relativePath: 'asc' }, { id: 'asc' }],
    take: 128,
    select: { id: true, relativePath: true, storagePath: true, sha256: true, sizeBytes: true },
  })
  const matching = candidates.filter((artifact) => {
    const root = moduleRoot(artifact.relativePath)
    return sourcePaths.every((path) => pathUnder(path, root))
  }).sort((a, b) => moduleRoot(b.relativePath).length - moduleRoot(a.relativePath).length)
  if (!matching.length) {
    if (candidates.length) throw new GoBuildInputError('Accepted Go files span module roots; build one Go module at a time.')
    return { moduleRoot: '', goMod: '', goModSha256: '', goSum: '', goSumSha256: '', dependencies: [] as Array<{ artifactId: string; relativePath: string; buildPath: 'go.mod' | 'go.sum'; sourceSha256: string }> }
  }

  const modArtifact = matching[0]
  const root = moduleRoot(modArtifact.relativePath)
  const goMod = await readManifest(modArtifact, 'go.mod')
  const goModSha256 = sha256(goMod)
  const sumPath = root ? `${root}/go.sum` : 'go.sum'
  const sumArtifact = await prisma.artifact.findFirst({
    where: { ...artifactWhere, relativePath: { equals: sumPath, mode: 'insensitive' } },
    select: { id: true, relativePath: true, storagePath: true, sha256: true, sizeBytes: true },
  })
  const goSum = sumArtifact ? await readManifest(sumArtifact, 'go.sum') : ''
  const goSumSha256 = goSum ? sha256(goSum) : ''
  const dependencies = [{
    artifactId: modArtifact.id,
    relativePath: modArtifact.relativePath,
    buildPath: 'go.mod' as const,
    sourceSha256: goModSha256,
  }, ...(sumArtifact && goSum ? [{
    artifactId: sumArtifact.id,
    relativePath: sumArtifact.relativePath,
    buildPath: 'go.sum' as const,
    sourceSha256: goSumSha256,
  }] : [])]
  return { moduleRoot: root, goMod, goModSha256, goSum, goSumSha256, dependencies }
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access
    const taskId = new URL(request.url).searchParams.get('taskId')?.trim() || ''
    if (!taskId || taskId.length > 128) return NextResponse.json({ error: 'Choose a completed analysis run first.' }, { status: 400 })
    const selection = await getActiveWorkspaceImportSelection(projectId)
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId, capability: { in: ['decompile', 'disassemble'] }, status: 'COMPLETED', artifact: { is: selection.artifactWhere } },
      select: { id: true, artifactId: true },
    })
    if (!task?.artifactId) return NextResponse.json({ error: 'Completed analysis run was not found in the active workspace import.' }, { status: 404 })
    const receipt = await getVerifiedGoProjectBuildReceipt(projectId, task.id, task.artifactId, selection.artifactWhere)
    return NextResponse.json({ receipt })
  } catch (error) {
    console.error('Go project build receipt lookup failed:', error)
    return NextResponse.json({ error: 'The Go project build receipt could not be loaded.' }, { status: 500 })
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : ''
    if (!taskId || taskId.length > 128) return NextResponse.json({ error: 'Choose a completed analysis run first.' }, { status: 400 })

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId, capability: { in: ['decompile', 'disassemble'] }, status: 'COMPLETED', artifact: { is: selection.artifactWhere } },
      select: { id: true, artifactId: true },
    })
    if (!task?.artifactId) return NextResponse.json({ error: 'Completed analysis run was not found in the active workspace import.' }, { status: 404 })

    const units = await prisma.reamonObservation.findMany({
      where: { projectId, taskId: task.id, type: CODE_UNIT_OBSERVATION_TYPE, artifact: { is: selection.artifactWhere } },
      take: MAX_INVENTORY_UNITS + 1,
      orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
      select: { id: true, attributes: true },
    })
    if (units.length > MAX_INVENTORY_UNITS) return NextResponse.json({ error: `This run exceeds the ${MAX_INVENTORY_UNITS.toLocaleString()}-unit project-build inventory limit.` }, { status: 413 })
    const goUnitIds = units.filter((unit) => goLanguage(plainObject(unit.attributes).language)).map((unit) => unit.id)
    if (!goUnitIds.length) return NextResponse.json({ error: 'This run has no Go source units to build.' }, { status: 422 })

    const sources = await prisma.reamonMaintainedSource.findMany({
      where: { projectId, artifactId: task.artifactId, codeUnitId: { in: goUnitIds }, acceptedReviewId: { not: null } },
      orderBy: [{ relativePath: 'asc' }, { codeUnitId: 'asc' }],
      take: MAX_BUILD_FILES + 1,
      select: { codeUnitId: true, sourceCode: true, sourceHash: true, acceptedReviewId: true, relativePath: true },
    })
    if (sources.length > MAX_BUILD_FILES) return NextResponse.json({ error: `This run has more than ${MAX_BUILD_FILES} accepted Go files; split the work into a smaller analysis run.` }, { status: 413 })
    if (!sources.length) return NextResponse.json({ error: 'Accept at least one maintained Go source file before building the project.' }, { status: 409 })

    const reviews = await prisma.reamonCodeReview.findMany({
      where: { projectId, artifactId: task.artifactId, id: { in: sources.flatMap((source) => source.acceptedReviewId ? [source.acceptedReviewId] : []) }, decision: 'ACCEPTED' },
      select: { id: true, codeUnitId: true, maintainedSourceHash: true },
    })
    const reviewById = new Map(reviews.map((review) => [review.id, review]))
    const sourceInputs: SourceInput[] = []
    let totalBytes = 0
    for (const source of sources) {
      const relativePath = safeGoPath(source.relativePath)
      const review = source.acceptedReviewId ? reviewById.get(source.acceptedReviewId) : null
      const sourceHash = sha256(source.sourceCode)
      if (!relativePath || !review || review.codeUnitId !== source.codeUnitId || !source.sourceHash
          || source.sourceHash !== sourceHash || review.maintainedSourceHash !== sourceHash) {
        return NextResponse.json({ error: 'An accepted Go source changed or no longer matches its review receipt; save and accept it again before building.' }, { status: 409 })
      }
      const sourceBytes = Buffer.byteLength(source.sourceCode, 'utf8')
      if (sourceBytes > MAX_SOURCE_BYTES) return NextResponse.json({ error: `${relativePath} exceeds the 512 KiB per-file build limit.` }, { status: 413 })
      totalBytes += sourceBytes
      if (totalBytes > MAX_BUILD_BYTES) return NextResponse.json({ error: 'Accepted Go source exceeds the 8 MiB combined project-build limit.' }, { status: 413 })
      sourceInputs.push({ unitId: source.codeUnitId, reviewId: review.id, relativePath, buildPath: relativePath, sourceCode: source.sourceCode, sourceHash })
    }

    const pathKeys = new Set<string>()
    for (const source of sourceInputs) {
      const key = source.relativePath.toLowerCase()
      if (pathKeys.has(key)) return NextResponse.json({ error: 'Accepted Go files have colliding paths; fix their source paths before building.' }, { status: 409 })
      pathKeys.add(key)
    }
    const manifests = await loadModuleManifests(selection.artifactWhere, sourceInputs.map((source) => source.relativePath))
    for (const source of sourceInputs) {
      source.buildPath = manifests.moduleRoot
        ? source.relativePath.slice(manifests.moduleRoot.length + 1)
        : source.relativePath
      if (!safeGoPath(source.buildPath)) return NextResponse.json({ error: 'A Go source path is outside the selected module root.' }, { status: 409 })
    }
    const buildPathKeys = new Set<string>()
    for (const source of sourceInputs) {
      const key = source.buildPath.toLowerCase()
      if (buildPathKeys.has(key)) return NextResponse.json({ error: 'Accepted Go files have colliding paths inside the module root.' }, { status: 409 })
      buildPathKeys.add(key)
    }

    const response = await agentFetch('/reamon/code/compile-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language: 'go',
        files: sourceInputs.map((source) => ({ relative_path: source.buildPath, source_code: source.sourceCode, expected_sha256: source.sourceHash })),
        go_mod: manifests.goMod,
        go_mod_sha256: manifests.goModSha256,
        go_sum: manifests.goSum,
        go_sum_sha256: manifests.goSumSha256,
      }),
    }, { timeoutMs: 40_000 })
    const result = await response.json().catch(() => null) as Record<string, unknown> | null
    if (result?.validation_status === 'UNAVAILABLE') {
      return NextResponse.json({ error: typeof result.validation_message === 'string' ? result.validation_message : 'Go project compilation is unavailable.' }, { status: 422 })
    }
    if (!response.ok || !result || !['PASSED', 'FAILED'].includes(String(result.validation_status))
        || typeof result.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.source_sha256)
        || typeof result.dependency_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.dependency_sha256)
        || typeof result.validation_method !== 'string' || !result.validation_method.startsWith('go-')
        || !result.validation_method.endsWith('-project-build') || result.file_count !== sourceInputs.length
        || !Array.isArray(result.files) || !Array.isArray(result.dependencies)) {
      return NextResponse.json({ error: 'The Go project compiler is unavailable or returned incomplete evidence; no build receipt was recorded.' }, { status: 503 })
    }

    const expectedFiles = [...sourceInputs].sort((a, b) => a.buildPath < b.buildPath ? -1 : a.buildPath > b.buildPath ? 1 : 0)
    const resultFiles = result.files as Array<Record<string, unknown>>
    if (resultFiles.length !== expectedFiles.length || resultFiles.some((file, index) =>
      file.relative_path !== expectedFiles[index].buildPath || file.source_sha256 !== expectedFiles[index].sourceHash)) {
      return NextResponse.json({ error: 'The Go compiler returned hashes that do not match the accepted files; no build receipt was recorded.' }, { status: 503 })
    }
    const expectedSourceHash = setHash(expectedFiles.map((source) => ({ path: source.buildPath, sourceHash: source.sourceHash })))
    if (result.source_sha256 !== expectedSourceHash) return NextResponse.json({ error: 'The Go compiler returned a receipt hash that does not match the accepted source set.' }, { status: 503 })

    const resultDependencies = result.dependencies as Array<Record<string, unknown>>
    const expectedDependencies = manifests.dependencies.map((dependency) => ({
      path: dependency.buildPath,
      sourceHash: dependency.sourceSha256,
    })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    if (resultDependencies.length !== expectedDependencies.length || resultDependencies.some((dependency, index) =>
      dependency.path !== expectedDependencies[index].path || dependency.source_sha256 !== expectedDependencies[index].sourceHash)) {
      return NextResponse.json({ error: 'The Go compiler returned dependency hashes that do not match the imported manifests; no build receipt was recorded.' }, { status: 503 })
    }
    const expectedDependencyHash = setHash(expectedDependencies)
    if (result.dependency_sha256 !== expectedDependencyHash) return NextResponse.json({ error: 'The Go compiler returned a dependency receipt hash that does not match the imported manifests.' }, { status: 503 })

    const createdAt = new Date().toISOString()
    const receipt = {
      version: 'reamon-go-project-build-v1',
      taskId: task.id,
      artifactId: task.artifactId,
      sourceSha256: expectedSourceHash,
      dependencySha256: expectedDependencyHash,
      validationStatus: result.validation_status,
      validationMethod: result.validation_method,
      compilerVersion: typeof result.compiler_version === 'string' ? result.compiler_version : 'unknown',
      validationMessage: typeof result.validation_message === 'string' ? result.validation_message.slice(0, 2000) : '',
      compiledSha256: typeof result.compiled_sha256 === 'string' && /^[a-f0-9]{64}$/.test(result.compiled_sha256) ? result.compiled_sha256 : null,
      packageCount: Number.isInteger(result.package_count) ? result.package_count : 0,
      createdAt,
      files: expectedFiles.map((source) => ({
        codeUnitId: source.unitId,
        acceptedReviewId: source.reviewId,
        relativePath: source.relativePath,
        buildPath: source.buildPath,
        sourceSha256: source.sourceHash,
      })),
      dependencies: manifests.dependencies,
    }
    const stableKey = `go-build:${task.id}:${expectedSourceHash}:${expectedDependencyHash}`
    await prisma.reamonObservation.upsert({
      where: { projectId_source_stableKey: { projectId, source: BUILD_SOURCE, stableKey } },
      create: {
        projectId,
        taskId: task.id,
        artifactId: task.artifactId,
        kind: 'build_evidence',
        type: 'project_build_receipt',
        stableKey,
        canonicalKey: `artifact:${task.artifactId}:task:${task.id}:go-build:${expectedSourceHash}:${expectedDependencyHash}`,
        label: `Go project build ${result.validation_status}`,
        source: BUILD_SOURCE,
        attributes: receipt as unknown as Prisma.InputJsonValue,
      },
      update: { label: `Go project build ${result.validation_status}`, attributes: receipt as unknown as Prisma.InputJsonValue, isPending: false },
      select: { id: true },
    })
    return NextResponse.json({ receipt })
  } catch (error) {
    if (error instanceof GoBuildInputError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('Go project build failed:', error)
    return NextResponse.json({ error: 'Go project build could not be completed.' }, { status: 500 })
  }
}

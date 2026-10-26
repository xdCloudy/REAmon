import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { agentFetch } from '@/lib/agentFetch'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { CODE_UNIT_OBSERVATION_TYPE } from '@/lib/reamon/code-units'

interface RouteParams { params: Promise<{ id: string }> }
const MAX_INVENTORY_UNITS = 5000
const MAX_BUILD_FILES = 32
const MAX_BUILD_BYTES = 2 * 1024 * 1024
const MAX_SOURCE_BYTES = 512 * 1024
const BUILD_SOURCE = 'reamon-maintained-build'

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function projectSourceSetHash(files: Array<{ relativePath: string; sourceHash: string }>): string {
  const ordered = [...files].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
  const hash = createHash('sha256')
  for (const file of ordered) hash.update(file.relativePath).update('\0').update(file.sourceHash).update('\n')
  return hash.digest('hex')
}

function csharpLanguage(value: unknown): boolean {
  return typeof value === 'string' && ['c#', 'csharp', 'c# source', 'cs'].includes(value.trim().toLowerCase())
}

function safeRelativePath(value: string): string | null {
  if (!value || value.length > 200 || value.includes('\\') || value.startsWith('/')) return null
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  const normalized = parts.map((part) => part.replace(/[^A-Za-z0-9_.-]/g, '_'))
  const path = normalized.join('/')
  if (!path.toLowerCase().endsWith('.cs')) return null
  return path
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
      where: {
        id: taskId,
        projectId,
        capability: { in: ['decompile', 'disassemble'] },
        status: 'COMPLETED',
        artifact: { is: selection.artifactWhere },
      },
      select: { id: true, artifactId: true },
    })
    if (!task?.artifactId) return NextResponse.json({ error: 'Completed analysis run was not found in the active workspace import.' }, { status: 404 })

    const stored = await prisma.reamonObservation.findFirst({
      where: { projectId, taskId: task.id, artifactId: task.artifactId, source: BUILD_SOURCE, type: 'project_build_receipt' },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      select: { stableKey: true, attributes: true },
    })
    if (!stored) return NextResponse.json({ receipt: null })

    const receipt = plainObject(stored.attributes)
    if (receipt.version !== 'reamon-csharp-project-build-v1' || receipt.taskId !== task.id
        || receipt.artifactId !== task.artifactId || !Array.isArray(receipt.files)
        || receipt.files.length < 1 || receipt.files.length > MAX_BUILD_FILES
        || !['PASSED', 'FAILED'].includes(String(receipt.validationStatus))
        || typeof receipt.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sourceSha256)) {
      return NextResponse.json({ receipt: null })
    }
    const receiptFiles = receipt.files.map((item) => plainObject(item))
    if (receiptFiles.some((file) => typeof file.codeUnitId !== 'string' || typeof file.acceptedReviewId !== 'string'
        || typeof file.relativePath !== 'string' || !safeRelativePath(file.relativePath)
        || typeof file.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sourceSha256))) {
      return NextResponse.json({ receipt: null })
    }
    const receiptUnitIds = receiptFiles.map((file) => file.codeUnitId as string)
    if (new Set(receiptUnitIds).size !== receiptUnitIds.length
        || new Set(receiptFiles.map((file) => String(file.relativePath).toLowerCase())).size !== receiptFiles.length) {
      return NextResponse.json({ receipt: null })
    }

    const units = await prisma.reamonObservation.findMany({
      where: { projectId, taskId: task.id, artifactId: task.artifactId, type: CODE_UNIT_OBSERVATION_TYPE },
      take: MAX_INVENTORY_UNITS + 1,
      select: { id: true, attributes: true },
    })
    if (units.length > MAX_INVENTORY_UNITS) return NextResponse.json({ receipt: null })
    const csharpUnitIds = units.filter((unit) => csharpLanguage(plainObject(unit.attributes).language)).map((unit) => unit.id)
    if (!csharpUnitIds.length || receiptUnitIds.some((unitId) => !csharpUnitIds.includes(unitId))) {
      return NextResponse.json({ receipt: null })
    }
    const sources = await prisma.reamonMaintainedSource.findMany({
      where: { projectId, artifactId: task.artifactId, codeUnitId: { in: csharpUnitIds }, acceptedReviewId: { not: null } },
      orderBy: [{ relativePath: 'asc' }, { codeUnitId: 'asc' }],
      take: MAX_BUILD_FILES + 1,
      select: { codeUnitId: true, sourceCode: true, sourceHash: true, acceptedReviewId: true, relativePath: true },
    })
    if (sources.length > MAX_BUILD_FILES || sources.length !== receiptFiles.length) {
      return NextResponse.json({ receipt: null })
    }
    const sourceUnitIds = sources.map((source) => source.codeUnitId)
    const reviewIds = sources.flatMap((source) => source.acceptedReviewId ? [source.acceptedReviewId] : [])
    if (new Set(sourceUnitIds).size !== sourceUnitIds.length
        || sourceUnitIds.some((unitId) => !receiptUnitIds.includes(unitId))) return NextResponse.json({ receipt: null })
    const reviews = await prisma.reamonCodeReview.findMany({
      where: { projectId, artifactId: task.artifactId, id: { in: reviewIds }, decision: 'ACCEPTED' },
      select: { id: true, codeUnitId: true, maintainedSourceHash: true },
    })
    const unitsById = new Map(units.map((unit) => [unit.id, unit]))
    const sourcesById = new Map(sources.map((source) => [source.codeUnitId, source]))
    const reviewsById = new Map(reviews.map((review) => [review.id, review]))
    const receiptFilesById = new Map(receiptFiles.map((file) => [file.codeUnitId as string, file]))
    for (const file of receiptFiles) {
      const unitId = file.codeUnitId as string
      const reviewId = file.acceptedReviewId as string
      const source = sourcesById.get(unitId)
      const review = reviewsById.get(reviewId)
      if (!unitsById.has(unitId) || !csharpLanguage(plainObject(unitsById.get(unitId)?.attributes).language)
          || !source || source.acceptedReviewId !== reviewId || source.relativePath !== file.relativePath
          || !source.sourceHash || source.sourceHash !== file.sourceSha256 || sha256(source.sourceCode) !== file.sourceSha256
          || !review || review.codeUnitId !== unitId || review.maintainedSourceHash !== file.sourceSha256) {
        return NextResponse.json({ receipt: null })
      }
    }
    const currentProjectHash = projectSourceSetHash(sources.map((source) => ({
      relativePath: source.relativePath,
      sourceHash: source.sourceHash ?? '',
    })))
    const sourceSetMatches = sources.every((source) => {
      const file = receiptFilesById.get(source.codeUnitId)
      return !!file && file.acceptedReviewId === source.acceptedReviewId
        && file.relativePath === source.relativePath && file.sourceSha256 === source.sourceHash
    })
    if (!sourceSetMatches || currentProjectHash !== receipt.sourceSha256) return NextResponse.json({ receipt: null })
    if (stored.stableKey !== `csharp-build:${task.id}:${currentProjectHash}`) {
      return NextResponse.json({ receipt: null })
    }

    return NextResponse.json({ receipt })
  } catch (error) {
    console.error('C# project build receipt lookup failed:', error)
    return NextResponse.json({ error: 'The C# project build receipt could not be loaded.' }, { status: 500 })
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
    if (!taskId || taskId.length > 128) {
      return NextResponse.json({ error: 'Choose a completed analysis run first.' }, { status: 400 })
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
      select: { id: true, artifactId: true, artifact: { select: { id: true } } },
    })
    if (!task?.artifactId) {
      return NextResponse.json({ error: 'Completed analysis run was not found in the active workspace import.' }, { status: 404 })
    }

    const codeUnits = await prisma.reamonObservation.findMany({
      where: {
        projectId,
        taskId: task.id,
        type: CODE_UNIT_OBSERVATION_TYPE,
        artifact: { is: selection.artifactWhere },
      },
      take: MAX_INVENTORY_UNITS + 1,
      orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
      select: { id: true, attributes: true },
    })
    if (codeUnits.length > MAX_INVENTORY_UNITS) {
      return NextResponse.json({ error: `This run exceeds the ${MAX_INVENTORY_UNITS.toLocaleString()}-unit project-build inventory limit.` }, { status: 413 })
    }
    const csharpUnitIds = codeUnits.filter((unit) => csharpLanguage(plainObject(unit.attributes).language)).map((unit) => unit.id)
    if (!csharpUnitIds.length) {
      return NextResponse.json({ error: 'This run has no C# source units to build.' }, { status: 422 })
    }

    const sources = await prisma.reamonMaintainedSource.findMany({
      where: {
        projectId,
        artifactId: task.artifactId,
        codeUnitId: { in: csharpUnitIds },
        acceptedReviewId: { not: null },
      },
      orderBy: [{ relativePath: 'asc' }, { codeUnitId: 'asc' }],
      take: MAX_BUILD_FILES + 1,
      select: { codeUnitId: true, sourceCode: true, sourceHash: true, acceptedReviewId: true, relativePath: true },
    })
    if (sources.length > MAX_BUILD_FILES) {
      return NextResponse.json({ error: `This run has more than ${MAX_BUILD_FILES} accepted C# files; split the work into a smaller analysis run.` }, { status: 413 })
    }
    if (!sources.length) {
      return NextResponse.json({ error: 'Accept at least one maintained C# source file before building the project.' }, { status: 409 })
    }

    const reviews = await prisma.reamonCodeReview.findMany({
      where: {
        projectId,
        id: { in: sources.flatMap((source) => source.acceptedReviewId ? [source.acceptedReviewId] : []) },
        artifactId: task.artifactId,
        decision: 'ACCEPTED',
      },
      select: { id: true, codeUnitId: true, maintainedSourceHash: true },
    })
    const reviewById = new Map(reviews.map((review) => [review.id, review]))
    const sourceInputs: Array<{ unitId: string; reviewId: string; relativePath: string; sourceCode: string; sourceHash: string }> = []
    let totalBytes = 0
    for (const source of sources) {
      const path = safeRelativePath(source.relativePath)
      const review = source.acceptedReviewId ? reviewById.get(source.acceptedReviewId) : null
      const sourceHash = sha256(source.sourceCode)
      if (!path || !review || review.codeUnitId !== source.codeUnitId || !source.sourceHash
          || source.sourceHash !== sourceHash || review.maintainedSourceHash !== sourceHash) {
        return NextResponse.json({ error: 'An accepted source changed or no longer matches its review receipt; save and accept it again before building.' }, { status: 409 })
      }
      const sourceBytes = Buffer.byteLength(source.sourceCode, 'utf8')
      if (sourceBytes > MAX_SOURCE_BYTES) {
        return NextResponse.json({ error: `${path} exceeds the 512 KiB per-file build limit.` }, { status: 413 })
      }
      totalBytes += sourceBytes
      if (totalBytes > MAX_BUILD_BYTES) {
        return NextResponse.json({ error: 'Accepted C# source exceeds the 2 MiB combined project-build limit.' }, { status: 413 })
      }
      sourceInputs.push({
        unitId: source.codeUnitId,
        reviewId: review.id,
        relativePath: path,
        sourceCode: source.sourceCode,
        sourceHash,
      })
    }

    const paths = new Set<string>()
    for (const source of sourceInputs) {
      const key = source.relativePath.toLowerCase()
      if (paths.has(key)) {
        return NextResponse.json({ error: 'Accepted C# files have colliding paths; fix their source paths before building.' }, { status: 409 })
      }
      paths.add(key)
    }

    const response = await agentFetch('/reamon/code/compile-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language: 'csharp',
        files: sourceInputs.map((source) => ({
          relative_path: source.relativePath,
          source_code: source.sourceCode,
          expected_sha256: source.sourceHash,
        })),
      }),
    }, { timeoutMs: 35_000 })
    const result = await response.json().catch(() => null) as Record<string, unknown> | null
    if (!response.ok || !result
        || !['PASSED', 'FAILED'].includes(String(result.validation_status))
        || typeof result.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(result.source_sha256)
        || typeof result.validation_method !== 'string' || !result.validation_method.startsWith('roslyn-csharp-project-')
        || result.file_count !== sourceInputs.length || !Array.isArray(result.files)) {
      return NextResponse.json({ error: 'The project compiler is unavailable or returned incomplete evidence; no build receipt was recorded.' }, { status: 503 })
    }

    const resultFiles = result.files as Array<Record<string, unknown>>
    const expectedFiles = [...sourceInputs].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
    if (resultFiles.length !== expectedFiles.length || resultFiles.some((file, index) =>
      file.relative_path !== expectedFiles[index].relativePath || file.source_sha256 !== expectedFiles[index].sourceHash)) {
      return NextResponse.json({ error: 'The project compiler returned source hashes that do not match the accepted files; no build receipt was recorded.' }, { status: 503 })
    }

    const createdAt = new Date().toISOString()
    const receipt = {
      version: 'reamon-csharp-project-build-v1',
      taskId: task.id,
      artifactId: task.artifactId,
      sourceSha256: result.source_sha256,
      validationStatus: result.validation_status,
      validationMethod: result.validation_method,
      compilerVersion: typeof result.compiler_version === 'string' ? result.compiler_version : 'unknown',
      validationMessage: typeof result.validation_message === 'string' ? result.validation_message.slice(0, 2000) : '',
      compiledSha256: typeof result.compiled_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(result.compiled_sha256) ? result.compiled_sha256 : null,
      createdAt,
      files: expectedFiles.map((source) => ({
        codeUnitId: source.unitId,
        acceptedReviewId: source.reviewId,
        relativePath: source.relativePath,
        sourceSha256: source.sourceHash,
      })),
    }
    const expectedProjectHash = projectSourceSetHash(expectedFiles)
    if (result.source_sha256 !== expectedProjectHash) {
      return NextResponse.json({ error: 'The project compiler returned a receipt hash that does not match the accepted source set.' }, { status: 503 })
    }
    const stableKey = `csharp-build:${task.id}:${expectedProjectHash}`
    await prisma.reamonObservation.upsert({
      where: { projectId_source_stableKey: { projectId, source: BUILD_SOURCE, stableKey } },
      create: {
        projectId,
        taskId: task.id,
        artifactId: task.artifactId,
        kind: 'build_evidence',
        type: 'project_build_receipt',
        stableKey,
        canonicalKey: `artifact:${task.artifactId}:task:${task.id}:csharp-build:${expectedProjectHash}`,
        label: `C# project build ${result.validation_status}`,
        source: BUILD_SOURCE,
        attributes: receipt as unknown as Prisma.InputJsonValue,
      },
      update: {
        label: `C# project build ${result.validation_status}`,
        attributes: receipt as unknown as Prisma.InputJsonValue,
        isPending: false,
      },
      select: { id: true },
    })

    return NextResponse.json({ receipt })
  } catch (error) {
    console.error('C# project build failed:', error)
    return NextResponse.json({ error: 'C# project build could not be completed.' }, { status: 500 })
  }
}

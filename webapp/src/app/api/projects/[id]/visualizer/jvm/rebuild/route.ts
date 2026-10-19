import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { artifactRoot, resolveArtifactStoragePath } from '@/lib/reamon/artifact-storage'

interface RouteParams { params: Promise<{ id: string }> }

const SUPPORTED_PROVIDERS = new Set(['reamon-jadx', 'reamon-cfr', 'reamon-vineflower'])
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_INPUT_BYTES = 512 * 1024 * 1024

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function safeRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 1000 || value.includes('\\') || value.includes('\0')) return null
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) return null
  return value.toLowerCase().endsWith('.java') ? value : null
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const contentLength = Number(request.headers.get('content-length') || 0)
    if (contentLength > 4096) return NextResponse.json({ error: 'Request body is too large' }, { status: 413 })
    let body: unknown
    try { body = await request.json() } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })
    }
    const taskId = record(body).taskId
    const codeUnitId = record(body).codeUnitId
    if (typeof taskId !== 'string' || !taskId || taskId.length > 128
        || typeof codeUnitId !== 'string' || !codeUnitId || codeUnitId.length > 128) {
      return NextResponse.json({ error: 'A completed JVM analysis run and code unit are required' }, { status: 400 })
    }

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        projectId,
        capability: 'decompile',
        status: 'COMPLETED',
        provider: { is: { pluginId: { in: [...SUPPORTED_PROVIDERS] } } },
        artifact: { is: selection.artifactWhere },
      },
      select: {
        id: true,
        artifactId: true,
        provider: { select: { pluginId: true } },
        artifact: { select: { originalName: true, storagePath: true, sha256: true, sizeBytes: true } },
      },
    })
    const providerId = task?.provider?.pluginId || ''
    const artifact = task?.artifact
    if (!task?.artifactId || !artifact || !SUPPORTED_PROVIDERS.has(providerId)
        || path.extname(artifact.originalName).toLowerCase() !== '.jar') {
      return NextResponse.json({ error: 'A completed Java decompilation run for a JVM JAR is required' }, { status: 404 })
    }
    if (!artifact.sha256 || artifact.sizeBytes <= 0 || artifact.sizeBytes > MAX_INPUT_BYTES) {
      return NextResponse.json({ error: 'The input JAR is missing a valid hash or exceeds the rebuild size limit' }, { status: 413 })
    }

    const unit = await prisma.reamonObservation.findFirst({
      where: { id: codeUnitId, projectId, artifactId: task.artifactId, taskId: task.id, source: providerId, type: 'code_unit' },
      select: { id: true, label: true, attributes: true },
    })
    const attributes = record(unit?.attributes)
    const relativePath = safeRelativePath(attributes.relativePath)
    if (!unit || attributes.language !== 'Java' || attributes.unitType !== 'class' || !relativePath) {
      return NextResponse.json({ error: 'Select a Java class produced by this JAR analysis run' }, { status: 404 })
    }

    const maintained = await prisma.reamonMaintainedSource.findUnique({
      where: { projectId_codeUnitId: { projectId, codeUnitId: unit.id } },
      select: { artifactId: true, language: true, sourceCode: true, sourceHash: true, acceptedReviewId: true },
    })
    const sourceHash = maintained?.sourceHash?.toLowerCase() || ''
    if (!maintained || maintained.artifactId !== task.artifactId || maintained.language !== 'Java'
        || !maintained.acceptedReviewId || !/^[a-f0-9]{64}$/.test(sourceHash)
        || createHash('sha256').update(maintained.sourceCode).digest('hex') !== sourceHash
        || Buffer.byteLength(maintained.sourceCode, 'utf8') > MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: 'Accept and save this Java source before rebuilding the JAR' }, { status: 409 })
    }
    const receipt = await prisma.reamonCodeReview.findFirst({
      where: {
        id: maintained.acceptedReviewId,
        projectId,
        artifactId: task.artifactId,
        codeUnitId: unit.id,
        decision: 'ACCEPTED',
        maintainedSourceHash: sourceHash,
      },
      select: { sourceSnapshot: true, maintainedSourceHash: true },
    })
    if (!receipt?.sourceSnapshot || receipt.maintainedSourceHash !== sourceHash
        || createHash('sha256').update(receipt.sourceSnapshot).digest('hex') !== sourceHash
        || receipt.sourceSnapshot !== maintained.sourceCode) {
      return NextResponse.json({ error: 'The accepted Java source failed its review receipt integrity check' }, { status: 409 })
    }

    const inputPath = resolveArtifactStoragePath(artifact.storagePath)
    const [artifactRootPath, artifactRealPath, inputInfo] = await Promise.all([
      realpath(artifactRoot()),
      realpath(inputPath),
      stat(inputPath),
    ])
    if (!isInside(artifactRootPath, artifactRealPath) || !inputInfo.isFile() || BigInt(inputInfo.size) !== artifact.sizeBytes
        || await sha256File(artifactRealPath) !== artifact.sha256.toLowerCase()) {
      return NextResponse.json({ error: 'The imported JAR failed its stored hash or path integrity check' }, { status: 409 })
    }

    const analyzerUrl = process.env.REAMON_ARLECCHINO_URL?.trim().replace(/\/$/, '')
    if (!analyzerUrl) return NextResponse.json({ error: 'The isolated JVM rebuild service is not configured' }, { status: 503 })
    const buildId = randomUUID().replaceAll('-', '')
    const controller = AbortSignal.timeout(180_000)
    let response: Response
    try {
      response = await fetch(`${analyzerUrl}/rebuild`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          projectId,
          artifactId: task.artifactId,
          taskId: task.id,
          buildId,
          artifactPath: artifactRealPath,
          artifactSha256: artifact.sha256.toLowerCase(),
          relativePath,
          sourceCode: receipt.sourceSnapshot,
          sourceSha256: sourceHash,
        }),
        signal: controller,
        cache: 'no-store',
      })
    } catch (error) {
      const message = error instanceof Error && error.name === 'TimeoutError'
        ? 'Java compilation exceeded the three minute request limit'
        : 'Could not reach the isolated JVM rebuild service'
      return NextResponse.json({ error: message }, { status: 502 })
    }
    const result = record(await response.json().catch(() => null))
    if (!response.ok || result.status !== 'completed') {
      const error = typeof result.error === 'string' ? result.error.slice(0, 8000) : `JVM source build failed with HTTP ${response.status}`
      return NextResponse.json({ error, validationStatus: result.validationStatus === 'FAILED' ? 'FAILED' : undefined }, {
        status: response.status === 422 ? 422 : response.status >= 500 ? 502 : 400,
      })
    }
    const expectedOutputPath = `${projectId}/${task.artifactId}/${task.id}/builds/${buildId}.jar`
    const outputPath = result.outputPath
    const outputHash = typeof result.sha256 === 'string' && /^[a-f0-9]{64}$/.test(result.sha256) ? result.sha256 : ''
    const sizeBytes = result.sizeBytes
    const changedClassCount = result.changedClassCount
    const removedClassCount = result.removedClassCount
    const javaRelease = result.javaRelease
    if (result.buildId !== buildId || outputPath !== expectedOutputPath || !outputHash
        || !Number.isSafeInteger(sizeBytes) || Number(sizeBytes) <= 0 || Number(sizeBytes) > MAX_INPUT_BYTES
        || !Number.isSafeInteger(changedClassCount) || Number(changedClassCount) < 1 || Number(changedClassCount) > 200
        || !Number.isSafeInteger(removedClassCount) || Number(removedClassCount) < 0 || Number(removedClassCount) > 200
        || !Number.isSafeInteger(javaRelease) || Number(javaRelease) < 8 || Number(javaRelease) > 21
        || result.inputSha256 !== artifact.sha256.toLowerCase() || result.sourceSha256 !== sourceHash) {
      return NextResponse.json({ error: 'The JVM rebuild service returned invalid output provenance' }, { status: 502 })
    }

    const outputPrefix = `${projectId}/${task.artifactId}/${task.id}/`
    const stableKey = `jvmbuild:${task.id}:${buildId}`
    const fileName = `${path.basename(artifact.originalName, path.extname(artifact.originalName))}.maintained.jar`.slice(-180)
    const warnings = typeof result.warnings === 'string' ? result.warnings.slice(0, 4000) : ''
    const diagnostics = typeof result.diagnostics === 'string' ? result.diagnostics.slice(0, 8000) : ''
    await prisma.$transaction([
      prisma.reamonObservation.create({
        data: {
          projectId,
          taskId: task.id,
          artifactId: task.artifactId,
          kind: 'artifact',
          type: 'jvm_build',
          stableKey,
          canonicalKey: stableKey,
          label: `${unit.label || relativePath} · rebuilt JAR`,
          source: 'reamon-jvm-source-build',
          attributes: {
            buildId,
            outputPath,
            outputPrefix,
            fileName,
            sizeBytes: Number(sizeBytes),
            sha256: outputHash,
            inputSha256: artifact.sha256.toLowerCase(),
            sourceSha256: sourceHash,
            codeUnitId: unit.id,
            sourceProviderId: providerId,
            relativePath,
            classEntry: typeof result.classEntry === 'string' ? result.classEntry.slice(0, 1000) : '',
            changedClassCount: Number(changedClassCount),
            removedClassCount: Number(removedClassCount),
            javaRelease: Number(javaRelease),
            compilerVersion: typeof result.compilerVersion === 'string' ? result.compilerVersion.slice(0, 120) : 'unknown',
            compilerDiagnostics: diagnostics,
            signed: false,
            warnings,
            createdAt: new Date().toISOString(),
          },
        },
      }),
      prisma.workspaceActivity.create({
        data: {
          projectId,
          actor: user.userId,
          eventType: 'jvm.jar.rebuilt',
          message: `Built a derived JAR from accepted Java source for ${relativePath}`,
          data: { taskId: task.id, artifactId: task.artifactId, buildId, sourceSha256: sourceHash, sha256: outputHash },
        },
      }),
    ])

    return NextResponse.json({
      buildId,
      taskId: task.id,
      codeUnitId: unit.id,
      fileName,
      sizeBytes: Number(sizeBytes),
      sha256: outputHash,
      sourceSha256: sourceHash,
      changedClassCount: Number(changedClassCount),
      removedClassCount: Number(removedClassCount),
      javaRelease: Number(javaRelease),
      compilerVersion: typeof result.compilerVersion === 'string' ? result.compilerVersion.slice(0, 120) : 'unknown',
      diagnostics,
      warnings,
      downloadUrl: `/api/projects/${encodeURIComponent(projectId)}/visualizer/jvm/build/${encodeURIComponent(buildId)}?taskId=${encodeURIComponent(task.id)}`,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to rebuild JVM source into a derived JAR:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message.slice(0, 1000) : 'Failed to rebuild JVM source' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

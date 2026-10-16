import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'

interface RouteParams { params: Promise<{ id: string }> }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function safeRelativeProjectPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 1000 || value.includes('\\') || value.includes('\u0000')) return null
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) return null
  return value
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    let body: unknown
    try { body = await request.json() } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })
    }
    const taskId = record(body).taskId
    if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 128) {
      return NextResponse.json({ error: 'A valid Android analysis run is required' }, { status: 400 })
    }

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        projectId,
        capability: 'decompile',
        status: 'COMPLETED',
        provider: { is: { pluginId: 'reamon-jadx' } },
        artifact: { is: selection.artifactWhere },
      },
      select: { id: true, artifactId: true, runToken: true, result: true, artifact: { select: { originalName: true, sha256: true } } },
    })
    if (!task?.artifactId) return NextResponse.json({ error: 'Completed JADX analysis run not found' }, { status: 404 })
    const projectPath = record(task.result).apktoolProjectPath
    const expectedProjectPath = task.runToken
      ? `${projectId}/${task.artifactId}/${task.id}/${task.runToken}/apktool-project`
      : ''
    if (typeof projectPath !== 'string' || !expectedProjectPath || projectPath !== expectedProjectPath) {
      return NextResponse.json({ error: 'This run does not contain a saved Apktool project. Re-run JADX on the imported APK.' }, { status: 409 })
    }

    const resourceMaintained = await prisma.$queryRaw<Array<{ unitId: string; relativePath: string | null; sourceCode: string }>>`
      SELECT o.id AS "unitId", o.attributes->>'relativePath' AS "relativePath", m.source_code AS "sourceCode"
      FROM "reamon_observations" AS o
      INNER JOIN "reamon_maintained_sources" AS m
        ON m.project_id = o.project_id AND m.code_unit_id = o.id AND m.artifact_id = o.artifact_id
      WHERE o.project_id = ${projectId} AND o.task_id = ${task.id} AND o.artifact_id = ${task.artifactId}
        AND o.type = 'code_unit' AND o.attributes->>'unitType' = 'resource'
      ORDER BY o.stable_key ASC, o.id ASC
      LIMIT 2001
    `
    const smaliMaintained = await prisma.reamonMaintainedSource.findMany({
      where: {
        projectId,
        artifactId: task.artifactId,
        language: 'Smali',
        codeUnitId: { startsWith: 'smali:' },
        relativePath: { startsWith: `${projectId}/${task.artifactId}/${task.id}/${task.runToken}/disassembly/` },
      },
      orderBy: { codeUnitId: 'asc' },
      select: { codeUnitId: true, sourceCode: true },
      take: 2001,
    })
    if (resourceMaintained.length > 2000 || smaliMaintained.length > 2000 || resourceMaintained.length + smaliMaintained.length > 2000) {
      return NextResponse.json({ error: 'This rebuild has more than 2,000 saved resource or Smali edits. Split the changes into smaller batches.' }, { status: 413 })
    }
    let changedSourceBytes = 0
    const resourceChanges = resourceMaintained.flatMap((item) => {
      changedSourceBytes += Buffer.byteLength(item.sourceCode, 'utf8')
      const relativePath = safeRelativeProjectPath(item.relativePath)
      return relativePath && item.sourceCode.trim()
        ? [{ unitId: item.unitId, relativePath, sourceCode: item.sourceCode, kind: 'resource' as const }]
        : []
    })
    const smaliChanges = smaliMaintained.flatMap((item) => {
      const unitId = item.codeUnitId.slice('smali:'.length)
      const classDeclarations = [...item.sourceCode.matchAll(/^\s*\.class\s+(?:(?:public|private|protected|static|final|abstract|interface|enum|synthetic|annotation|constructor|declared-synchronized)\s+)*(L[^\s;]+;)\s*$/gm)]
      changedSourceBytes += Buffer.byteLength(item.sourceCode, 'utf8')
      return classDeclarations.length === 1 && item.sourceCode.trim()
        ? [{ unitId, classDescriptor: classDeclarations[0][1], sourceCode: item.sourceCode, kind: 'smali' as const }]
        : []
    })
    if (resourceChanges.length !== resourceMaintained.length) {
      return NextResponse.json({ error: 'A saved resource edit no longer maps to a valid Apktool project path.' }, { status: 422 })
    }
    if (smaliChanges.length !== smaliMaintained.length) {
      return NextResponse.json({ error: 'A saved Smali edit has no valid class descriptor. Correct the .class declaration before rebuilding.' }, { status: 422 })
    }
    const changes = [...resourceChanges, ...smaliChanges]
    if (changedSourceBytes > 16 * 1024 * 1024) {
      return NextResponse.json({ error: 'Saved resource and Smali edits exceed the 16 MiB rebuild request limit. Split the changes into smaller batches.' }, { status: 413 })
    }
    const changeRecords = changes.map((change) => ({
      unitId: change.unitId,
      ...(change.kind === 'resource' ? { relativePath: change.relativePath } : { classDescriptor: change.classDescriptor }),
      kind: change.kind,
      sourceSha256: createHash('sha256').update(change.sourceCode, 'utf8').digest('hex'),
    }))
    const baseUrl = process.env.REAMON_JADX_URL?.trim().replace(/\/$/, '')
    if (!baseUrl) return NextResponse.json({ error: 'The isolated Apktool analyzer is not configured' }, { status: 503 })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30 * 60_000)
    let response: Response
    try {
      response = await fetch(`${baseUrl}/rebuild`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ projectId, artifactId: task.artifactId, taskId: task.id, runId: task.runToken,
          changes: changes.map((change) => change.kind === 'resource'
            ? { relativePath: change.relativePath, sourceCode: change.sourceCode }
            : { classDescriptor: change.classDescriptor, sourceCode: change.sourceCode }) }),
        signal: controller.signal,
        cache: 'no-store',
      })
    } finally {
      clearTimeout(timeout)
    }
    const result = record(await response.json().catch(() => null))
    if (!response.ok || result.status !== 'completed') {
      const error = typeof result.error === 'string' ? result.error.slice(0, 2000) : `Apktool build failed with HTTP ${response.status}`
      return NextResponse.json({ error }, { status: response.status >= 500 ? 502 : response.status })
    }
    const buildId = result.buildId
    const outputPath = safeRelativeProjectPath(result.outputPath)
    const sha256 = typeof result.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(result.sha256) ? result.sha256.toLowerCase() : ''
    const sizeBytes = typeof result.sizeBytes === 'number' && Number.isSafeInteger(result.sizeBytes) && result.sizeBytes > 0 ? result.sizeBytes : 0
    if (typeof buildId !== 'string' || !/^[a-f0-9]{32}$/.test(buildId) || !outputPath || !sha256 || !sizeBytes
        || outputPath !== `${projectId}/${task.artifactId}/${task.id}/${task.runToken}/builds/${buildId}.apk`) {
      return NextResponse.json({ error: 'Apktool returned incomplete rebuild metadata' }, { status: 502 })
    }

    const stableKey = `apkbuild:${task.id}:${buildId}`
    const label = `${task.artifact?.originalName || 'Android app'} · unsigned rebuild`
    await prisma.$transaction([
      prisma.reamonObservation.create({
        data: {
          projectId,
          taskId: task.id,
          artifactId: task.artifactId,
          kind: 'artifact',
          type: 'apk_build',
          stableKey,
          canonicalKey: stableKey,
          label,
          source: 'reamon-apktool-build',
          attributes: {
            buildId,
            outputPath,
            fileName: 'rebuilt-app.unsigned.apk',
            sizeBytes,
            sha256,
            inputSha256: task.artifact?.sha256 || null,
            signed: false,
            changedFileCount: typeof result.changedFileCount === 'number' ? result.changedFileCount : 0,
            changeRecords,
            apktoolVersion: typeof result.apktoolVersion === 'string' ? result.apktoolVersion.slice(0, 80) : 'unknown',
            warnings: typeof result.warnings === 'string' ? result.warnings.slice(0, 4000) : '',
            createdAt: new Date().toISOString(),
          },
        },
      }),
      prisma.workspaceActivity.create({
        data: {
          projectId,
          actor: user.userId,
          eventType: 'android.apk.rebuilt',
          message: `Built unsigned APK from JADX run ${task.id}`,
          data: { taskId: task.id, artifactId: task.artifactId, buildId, sha256, sizeBytes },
        },
      }),
    ])

    return NextResponse.json({
      buildId,
      taskId: task.id,
      fileName: 'rebuilt-app.unsigned.apk',
      sizeBytes,
      sha256,
      signed: false,
      changedFileCount: typeof result.changedFileCount === 'number' ? result.changedFileCount : 0,
      warnings: typeof result.warnings === 'string' ? result.warnings.slice(0, 4000) : '',
      downloadUrl: `/api/projects/${encodeURIComponent(projectId)}/visualizer/apk/build/${encodeURIComponent(buildId)}?taskId=${encodeURIComponent(task.id)}`,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to rebuild Android project with Apktool:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message.slice(0, 1000) : 'Failed to rebuild Android project' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

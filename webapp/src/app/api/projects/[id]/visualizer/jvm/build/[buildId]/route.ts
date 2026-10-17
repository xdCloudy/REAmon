import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'

interface RouteParams { params: Promise<{ id: string; buildId: string }> }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function safeFileName(value: unknown): string {
  if (typeof value !== 'string') return 'rebuilt-source.jar'
  return value.replace(/["\\/\u0000-\u001f\u007f]/g, '_').slice(0, 180) || 'rebuilt-source.jar'
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, buildId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access
    if (!/^[a-f0-9]{32}$/.test(buildId)) return NextResponse.json({ error: 'Invalid JVM build id' }, { status: 400 })

    const taskId = new URL(request.url).searchParams.get('taskId') || ''
    if (!taskId || taskId.length > 128) return NextResponse.json({ error: 'JVM analysis run not found' }, { status: 404 })
    const selection = await getActiveWorkspaceImportSelection(projectId)
    const row = await prisma.reamonObservation.findFirst({
      where: {
        projectId,
        taskId,
        source: 'reamon-jvm-source-build',
        type: 'jvm_build',
        stableKey: `jvmbuild:${taskId}:${buildId}`,
        artifact: { is: selection.artifactWhere },
      },
      select: { artifactId: true, attributes: true },
    })
    if (!row?.artifactId) return NextResponse.json({ error: 'JVM build not found in the active workspace' }, { status: 404 })
    const attributes = record(row.attributes)
    const expectedPath = `${projectId}/${row.artifactId}/${taskId}/builds/${buildId}.jar`
    if (attributes.outputPath !== expectedPath || attributes.signed !== false) {
      return NextResponse.json({ error: 'JVM build path is invalid' }, { status: 404 })
    }

    const root = derivedArtifactRoot()
    const filePath = resolveDerivedArtifactPath(expectedPath)
    const [rootRealPath, fileRealPath] = await Promise.all([realpath(root), realpath(filePath)])
    if (!isInside(rootRealPath, fileRealPath)) return NextResponse.json({ error: 'JVM build path is invalid' }, { status: 404 })
    const info = await stat(fileRealPath)
    if (!info.isFile() || info.size <= 0 || info.size > 512 * 1024 * 1024
        || (typeof attributes.sizeBytes === 'number' && info.size !== attributes.sizeBytes)) {
      return NextResponse.json({ error: 'JVM build is missing or invalid' }, { status: 404 })
    }
    return new NextResponse(Readable.toWeb(createReadStream(fileRealPath)) as ReadableStream<Uint8Array>, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': 'application/java-archive',
        'Content-Length': String(info.size),
        'Content-Disposition': `attachment; filename="${safeFileName(attributes.fileName)}"`,
        'X-Content-Type-Options': 'nosniff',
        'X-Artifact-SHA256': typeof attributes.sha256 === 'string' ? attributes.sha256 : '',
        'X-JVM-Signature-Status': 'unsigned',
      },
    })
  } catch (error) {
    console.error('Failed to download rebuilt JVM JAR:', error)
    return NextResponse.json({ error: 'Failed to download JVM build' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

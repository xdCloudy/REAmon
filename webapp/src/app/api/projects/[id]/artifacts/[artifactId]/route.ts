import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'

interface RouteParams {
  params: Promise<{ id: string; artifactId: string }>
}

function artifactRoot(): string {
  return path.resolve(process.env.REAMON_ARTIFACTS_PATH || path.join(process.cwd(), 'data', 'reamon-artifacts'))
}

function safeDownloadName(name: string): string {
  const normalized = name.replace(/["\\/\u0000-\u001f\u007f]/g, '_').trim()
  return (normalized || 'artifact').slice(0, 180)
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, artifactId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const artifact = await prisma.artifact.findFirst({
      where: { id: artifactId, projectId },
      select: { storagePath: true, originalName: true, mimeType: true, sizeBytes: true },
    })
    if (!artifact) return NextResponse.json({ error: 'Artifact not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })

    const root = artifactRoot()
    const filePath = path.resolve(root, artifact.storagePath)
    const relative = path.relative(root, filePath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      console.error('Refusing artifact path outside REAmon storage root')
      return NextResponse.json({ error: 'Artifact storage path is invalid' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
    }

    const bytes = await readFile(filePath)
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': artifact.mimeType || 'application/octet-stream',
        'Content-Length': String(artifact.sizeBytes),
        'Content-Disposition': `attachment; filename="${safeDownloadName(artifact.originalName)}"`,
      },
    })
  } catch (error) {
    console.error('Failed to download REAmon artifact:', error)
    return NextResponse.json({ error: 'Artifact is unavailable' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
  }
}

import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'
import { derivedArtifactRoot, resolveDerivedArtifactPath } from '@/lib/reamon/derived-storage'

interface RouteParams { params: Promise<{ id: string; artifactId: string; codePath: string[] }> }
const MAX_SOURCE_BYTES = 2 * 1024 * 1024

function safeName(value: string): string {
  return value.replace(/["\\/\u0000-\u001f\u007f]/g, '_').slice(0, 180) || 'decompiled.java'
}

function staysInside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, artifactId, codePath } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access
    if (!Array.isArray(codePath) || !codePath.length || codePath.some((part) => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\'))) {
      return NextResponse.json({ error: 'Invalid decompiled source path' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const relativePath = codePath.join('/')
    if (!relativePath.startsWith(`${projectId}/${artifactId}/`)) {
      return NextResponse.json({ error: 'Source does not belong to this artifact' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    }

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const artifact = await prisma.artifact.findFirst({
      where: { AND: [{ id: artifactId, projectId }, selection.artifactWhere] },
      select: { id: true },
    })
    if (!artifact) return NextResponse.json({ error: 'Artifact not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })

    const linkedCodeUnit = await prisma.reamonObservation.findFirst({
      where: {
        projectId,
        artifactId,
        type: 'code_unit',
        attributes: { path: ['codeArtifactId'], equals: relativePath },
      },
      select: { id: true },
    })
    if (!linkedCodeUnit) {
      return NextResponse.json({ error: 'Decompiled source not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    }

    const configuredRoot = derivedArtifactRoot()
    const filePath = resolveDerivedArtifactPath(relativePath)
    const [rootRealPath, fileRealPath] = await Promise.all([realpath(configuredRoot), realpath(filePath)])
    if (!staysInside(rootRealPath, fileRealPath)) {
      return NextResponse.json({ error: 'Decompiled source path is invalid' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    }
    const fileInfo = await stat(fileRealPath)
    if (!fileInfo.isFile() || fileInfo.size > MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: 'Decompiled source exceeds the view limit' }, { status: 413, headers: { 'Cache-Control': 'no-store' } })
    }
    const bytes = await readFile(fileRealPath)
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `inline; filename="${safeName(codePath[codePath.length - 1])}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (error) {
    console.error('Failed to load REAmon decompiled source:', error)
    return NextResponse.json({ error: 'Failed to load decompiled source' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

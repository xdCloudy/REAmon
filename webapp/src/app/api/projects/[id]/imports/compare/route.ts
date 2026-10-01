import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { compareWorkspaceImports, type ImportComparisonEntry } from '@/lib/reamon/imports'
import { parseImportManifest } from '@/lib/reamon/import-manifest'
import { normalizeRootName } from '@/lib/reamon/paths'

interface RouteParams { params: Promise<{ id: string }> }

/**
 * Compare a new browser snapshot with the latest completed snapshot of the
 * same logical root. This is a manifest preflight: authoritative SHA-256
 * comparison happens when the import is finalized after upload.
 */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const body = await request.json() as { rootName?: unknown; files?: unknown }
    const rootName = normalizeRootName(String(body.rootName || ''))
    const { entries } = parseImportManifest(body.files)
    const previousImport = await prisma.workspaceImport.findFirst({
      where: { projectId, rootName, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, manifest: true },
    })
    const previousManifest = Array.isArray(previousImport?.manifest)
      ? previousImport.manifest as Array<{ relativePath?: unknown; size?: unknown; lastModified?: unknown }>
      : []
    const comparison = compareWorkspaceImports(
      previousManifest
        .filter((entry) => typeof entry.relativePath === 'string')
        .map((entry): ImportComparisonEntry => ({
          relativePath: entry.relativePath as string,
          size: Number(entry.size),
          lastModified: entry.lastModified == null || !Number.isFinite(Number(entry.lastModified)) ? null : Number(entry.lastModified),
        })),
      entries,
      { mode: 'MANIFEST', previousImportId: previousImport?.id },
    )

    return NextResponse.json({ rootName, comparison }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to compare workspace snapshot'
    const status = /limit|path|manifest|file|required|invalid|duplicate/i.test(message) ? 400 : 500
    console.error('Failed to compare REAmon workspace snapshot:', error)
    return NextResponse.json({ error: status === 400 ? message : 'Failed to compare workspace snapshot' }, { status, headers: { 'Cache-Control': 'no-store' } })
  }
}

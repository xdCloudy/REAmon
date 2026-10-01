import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'

interface RouteParams { params: Promise<{ id: string; importId: string }> }

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, importId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const workspaceImport = await prisma.workspaceImport.findFirst({
      where: { id: importId, projectId },
      include: {
        rootTarget: { select: { profile: true } },
        artifacts: { select: { relativePath: true } },
      },
    })
    if (!workspaceImport) return NextResponse.json({ error: 'Import not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })

    const manifest = Array.isArray(workspaceImport.manifest) ? workspaceImport.manifest as Array<{ relativePath?: unknown }> : []
    const uploaded = new Set(workspaceImport.artifacts.map((artifact) => artifact.relativePath))
    const missingPaths = manifest
      .map((entry) => typeof entry.relativePath === 'string' ? entry.relativePath : '')
      .filter((relativePath) => relativePath && !uploaded.has(relativePath))
      .slice(0, 200)

    return NextResponse.json({
      id: workspaceImport.id,
      sourceType: workspaceImport.sourceType,
      rootName: workspaceImport.rootName,
      status: workspaceImport.status,
      totalFiles: workspaceImport.totalFiles,
      completedFiles: workspaceImport.completedFiles,
      failedFiles: workspaceImport.failedFiles,
      totalBytes: Number(workspaceImport.totalBytes),
      uploadedBytes: Number(workspaceImport.uploadedBytes),
      errorSummary: workspaceImport.errorSummary,
      completedAt: workspaceImport.completedAt?.toISOString() || null,
      rootTargetId: workspaceImport.rootTargetId,
      missingPaths,
      profile: workspaceImport.rootTarget?.profile || null,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to read REAmon workspace import:', error)
    return NextResponse.json({ error: 'Failed to read workspace import' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

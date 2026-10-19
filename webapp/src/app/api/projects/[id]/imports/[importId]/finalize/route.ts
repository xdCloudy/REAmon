import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { buildWorkspaceProfile } from '@/lib/reamon/inventory'
import { compareWorkspaceImports, type ImportComparisonEntry } from '@/lib/reamon/imports'

interface RouteParams { params: Promise<{ id: string; importId: string }> }

function missingManifestPaths(manifest: unknown, uploaded: Set<string>): string[] {
  if (!Array.isArray(manifest)) return []
  return manifest
    .map((entry) => entry && typeof entry === 'object' && typeof (entry as { relativePath?: unknown }).relativePath === 'string'
      ? (entry as { relativePath: string }).relativePath
      : '')
    .filter((relativePath) => relativePath && !uploaded.has(relativePath))
}

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, importId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    // This conditional write acquires the import row lock before reading its
    // manifest/artifacts. Artifact uploads use the same row as their lock, so
    // the snapshot below cannot miss a commit that finished before finalizing.
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.workspaceImport.updateMany({
        where: { id: importId, projectId, status: { notIn: ['COMPLETED'] } },
        data: { status: 'FINALIZING' },
      })
      const workspaceImport = await tx.workspaceImport.findFirst({
        where: { id: importId, projectId },
        select: {
          id: true,
          projectId: true,
          rootName: true,
          status: true,
          manifest: true,
          metadata: true,
          rootTarget: { select: { id: true } },
          artifacts: { select: { id: true, relativePath: true, sizeBytes: true, sha256: true, profile: true } },
        },
      })
      if (!workspaceImport) return { kind: 'NOT_FOUND' as const }
      if (workspaceImport.status === 'COMPLETED') return { kind: 'ALREADY_COMPLETED' as const }
      if (!workspaceImport.rootTarget?.id) return { kind: 'MISSING_ROOT' as const }

      const uploaded = new Set(workspaceImport.artifacts.map((artifact) => artifact.relativePath))
      const missingPaths = missingManifestPaths(workspaceImport.manifest, uploaded)
      if (missingPaths.length > 0) {
        const errorSummary = `${missingPaths.length} file${missingPaths.length === 1 ? '' : 's'} still need uploading`
        await tx.workspaceImport.update({
          where: { id: importId },
          data: { status: 'FAILED', failedFiles: missingPaths.length, errorSummary },
        })
        return { kind: 'MISSING_PATHS' as const, missingPaths, errorSummary }
      }

      const profile = buildWorkspaceProfile(workspaceImport.artifacts.map((artifact) => ({
        relativePath: artifact.relativePath,
        sizeBytes: artifact.sizeBytes,
        profile: artifact.profile as never,
      })))
      const uploadedBytes = workspaceImport.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0)
      const previousImport = await tx.workspaceImport.findFirst({
        where: {
          projectId,
          rootName: workspaceImport.rootName,
          status: 'COMPLETED',
          NOT: { id: importId },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          artifacts: { select: { relativePath: true, sizeBytes: true, sha256: true } },
        },
      })
      const comparison = compareWorkspaceImports(
        previousImport?.artifacts.map((artifact): ImportComparisonEntry => ({
          relativePath: artifact.relativePath,
          size: artifact.sizeBytes,
          sha256: artifact.sha256,
        })) || [],
        workspaceImport.artifacts.map((artifact): ImportComparisonEntry => ({
          relativePath: artifact.relativePath,
          size: artifact.sizeBytes,
          sha256: artifact.sha256,
        })),
        { mode: 'HASH', previousImportId: previousImport?.id },
      )
      const metadata = workspaceImport.metadata && typeof workspaceImport.metadata === 'object' && !Array.isArray(workspaceImport.metadata)
        ? workspaceImport.metadata as Record<string, unknown>
        : {}
      const completed = await tx.workspaceImport.update({
        where: { id: importId },
        data: {
          status: 'COMPLETED',
          completedFiles: workspaceImport.artifacts.length,
          failedFiles: 0,
          uploadedBytes: BigInt(uploadedBytes),
          errorSummary: '',
          completedAt: new Date(),
          metadata: { ...metadata, comparison } as unknown as Prisma.InputJsonValue,
        },
      })
      await tx.target.update({
        where: { id: workspaceImport.rootTarget.id },
        data: { status: 'IDENTIFIED', profile: profile as unknown as Prisma.InputJsonValue },
      })
      await tx.workspaceActivity.create({
        data: {
          projectId,
          actor: 'Profiler',
          eventType: 'workspace.import.completed',
          message: `Imported ${workspaceImport.rootName} (${workspaceImport.artifacts.length.toLocaleString()} files)`,
          data: { importId, rootTargetId: workspaceImport.rootTarget.id, profile: profile as unknown as Prisma.InputJsonValue },
        },
      })
      return { kind: 'COMPLETED' as const, workspaceImport: completed, profile, uploadedBytes, comparison }
    })

    if (outcome.kind === 'NOT_FOUND') return NextResponse.json({ error: 'Import not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    if (outcome.kind === 'MISSING_ROOT') return NextResponse.json({ error: 'Import root target is missing' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    if (outcome.kind === 'MISSING_PATHS') {
      return NextResponse.json({ status: 'FAILED', importId, missingPaths: outcome.missingPaths.slice(0, 200), error: outcome.errorSummary }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
    if (outcome.kind === 'ALREADY_COMPLETED') {
      return NextResponse.json({ status: 'COMPLETED', importId, missingPaths: [] }, { headers: { 'Cache-Control': 'no-store' } })
    }

    return NextResponse.json({
      status: outcome.workspaceImport.status,
      importId: outcome.workspaceImport.id,
      rootTargetId: outcome.workspaceImport.rootTargetId,
      profile: outcome.profile,
      completedFiles: outcome.workspaceImport.completedFiles,
      uploadedBytes: outcome.uploadedBytes,
      missingPaths: [],
      comparison: outcome.comparison,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('Failed to finalize REAmon workspace import:', error)
    return NextResponse.json({ error: 'Failed to finalize workspace import' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

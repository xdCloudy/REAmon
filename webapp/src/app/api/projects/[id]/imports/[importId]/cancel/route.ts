import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'

interface RouteParams { params: Promise<{ id: string; importId: string }> }

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, importId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const workspaceImport = await prisma.workspaceImport.findFirst({
      where: { id: importId, projectId },
      select: { id: true, status: true, totalFiles: true, completedFiles: true, rootName: true },
    })
    if (!workspaceImport) return NextResponse.json({ error: 'Import not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    if (workspaceImport.status === 'COMPLETED') {
      return NextResponse.json({ error: 'Completed imports cannot be cancelled' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }
    if (workspaceImport.status === 'CANCELLED') {
      return NextResponse.json({ status: 'CANCELLED', importId }, { headers: { 'Cache-Control': 'no-store' } })
    }

    const cancelled = await prisma.$transaction(async (tx) => {
      const updated = await tx.workspaceImport.update({
        where: { id: importId },
        data: {
          status: 'CANCELLED',
          failedFiles: Math.max(0, workspaceImport.totalFiles - workspaceImport.completedFiles),
          errorSummary: 'Import cancelled by operator',
        },
      })
      await tx.workspaceActivity.create({
        data: {
          projectId,
          actor: 'Operator',
          eventType: 'workspace.import.cancelled',
          message: `Cancelled import of ${workspaceImport.rootName}`,
          data: { importId, completedFiles: workspaceImport.completedFiles, totalFiles: workspaceImport.totalFiles },
        },
      })
      return updated
    })

    return NextResponse.json({ status: cancelled.status, importId: cancelled.id }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('Failed to cancel REAmon workspace import:', error)
    return NextResponse.json({ error: 'Failed to cancel workspace import' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

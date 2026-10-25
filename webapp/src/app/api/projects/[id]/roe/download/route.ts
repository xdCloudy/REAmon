import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { guardProjectStrict } from '@/lib/access'

// GET /api/projects/[id]/roe/download - Download the original RoE document
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const denied = await guardProjectStrict(id)
    if (denied) return denied

    const project = await prisma.project.findUnique({
      where: { id },
      select: {
        roeDocumentData: true,
        roeDocumentName: true,
        roeDocumentMimeType: true,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!project.roeDocumentData) {
      return NextResponse.json({ error: 'No RoE document uploaded' }, { status: 404 })
    }

    const fileName = project.roeDocumentName || 'roe-document'
    const mimeType = project.roeDocumentMimeType || 'application/octet-stream'

    return new NextResponse(project.roeDocumentData, {
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': String(project.roeDocumentData.length),
      },
    })
  } catch (error) {
    console.error('RoE download error:', error)
    return NextResponse.json({ error: 'Failed to download RoE document' }, { status: 500 })
  }
}

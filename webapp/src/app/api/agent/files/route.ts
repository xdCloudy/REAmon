import { NextRequest, NextResponse } from 'next/server'
import { guardProject } from '@/lib/access'
import { internalKeyHeaders } from '@/lib/agentAuth'

const AGENT_API_URL = process.env.AGENT_API_URL || process.env.NEXT_PUBLIC_AGENT_API_URL || 'http://localhost:8080'

export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get('path')
  const projectId = request.nextUrl.searchParams.get('projectId')
  if (!projectId || !path) {
    return NextResponse.json({ error: 'Missing projectId or path parameter' }, { status: 400 })
  }
  const __denied = await guardProject(projectId)
  if (__denied) return __denied

  try {
    const agentUrl = `${AGENT_API_URL}/workspace/download?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`
    const resp = await fetch(agentUrl, { headers: internalKeyHeaders() })

    if (!resp.ok) {
      const text = await resp.text()
      return NextResponse.json({ error: text }, { status: resp.status })
    }

    const buffer = await resp.arrayBuffer()
    const contentDisposition = resp.headers.get('Content-Disposition') || `attachment; filename="${path.split('/').pop()}"`
    const contentType = resp.headers.get('Content-Type') || 'application/octet-stream'

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': contentDisposition,
        'Content-Length': String(buffer.byteLength),
        'Cache-Control': 'no-cache',
      },
    })
  } catch (error) {
    console.error('File proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to download file' },
      { status: 500 }
    )
  }
}

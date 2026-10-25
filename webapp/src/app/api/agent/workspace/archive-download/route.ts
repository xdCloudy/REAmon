import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { guardProject } from '@/lib/access'


export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get('projectId')
  const __denied = await guardProject(projectId || '')
  if (__denied) return __denied
  const path = request.nextUrl.searchParams.get('path')
  const format = request.nextUrl.searchParams.get('format') ?? 'tar.gz'

  if (!projectId || !path) {
    return NextResponse.json({ error: 'projectId, path required' }, { status: 400 })
  }

  try {
    const url = `/workspace/archive-download?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}&format=${encodeURIComponent(format)}`
    const resp = await agentFetch(url)
    if (!resp.ok) {
      const text = await resp.text()
      return NextResponse.json({ error: text }, { status: resp.status })
    }
    const buffer = await resp.arrayBuffer()
    const contentDisposition = resp.headers.get('Content-Disposition') || ''
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
    console.error('workspace/archive-download proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to download archive' },
      { status: 502 }
    )
  }
}

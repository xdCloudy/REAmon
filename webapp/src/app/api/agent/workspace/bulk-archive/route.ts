import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { guardProject } from '@/lib/access'


export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  let body: { projectId?: string; paths?: string[]; format?: string; archiveName?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!body.projectId || !Array.isArray(body.paths) || body.paths.length === 0) {
    return NextResponse.json({ error: 'projectId + non-empty paths required' }, { status: 400 })
  }
  const __denied = await guardProject(body.projectId || '')
  if (__denied) return __denied

  try {
    const resp = await agentFetch(`/workspace/bulk-archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
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
    console.error('workspace/bulk-archive proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to build archive' },
      { status: 502 }
    )
  }
}

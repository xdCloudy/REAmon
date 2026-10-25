import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { guardProject } from '@/lib/access'


export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const projectId = searchParams.get('projectId')
  const path = searchParams.get('path')
  const overwrite = searchParams.get('overwrite')
  const filename = searchParams.get('filename')
  if (!projectId || filename === null || path === null || overwrite === null) {
    return NextResponse.json({ error: 'projectId, path, overwrite, and filename are required' }, { status: 400 })
  }
  const __denied = await guardProject(projectId)
  if (__denied) return __denied
  if (!filename) {
    return NextResponse.json({ error: 'filename required' }, { status: 400 })
  }

  try {
    const upstreamQuery = new URLSearchParams({ projectId, path, overwrite, filename })
    const init = {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type') || 'application/octet-stream' },
      body: request.body,
      duplex: 'half' as const,
      signal: request.signal,
    } as RequestInit & { duplex: 'half' }
    const resp = await agentFetch(
      `/workspace/upload?${upstreamQuery.toString()}`,
      init,
      { timeoutMs: 0 },
    )
    const data = await resp.json()
    return NextResponse.json(data, { status: resp.status })
  } catch (error) {
    console.error('workspace/upload proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to upload' },
      { status: 502 }
    )
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { guardProject } from '@/lib/access'


export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get('projectId')
  const __denied = await guardProject(projectId || '')
  if (__denied) return __denied
  const path = request.nextUrl.searchParams.get('path')
  const maxBytes = request.nextUrl.searchParams.get('maxBytes')

  if (!projectId || !path) {
    return NextResponse.json({ error: 'projectId, path required' }, { status: 400 })
  }

  try {
    let url = `/workspace/preview?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`
    if (maxBytes) url += `&maxBytes=${encodeURIComponent(maxBytes)}`
    const resp = await agentFetch(url, { cache: 'no-store' })
    const data = await resp.json()
    return NextResponse.json(data, { status: resp.status })
  } catch (error) {
    console.error('workspace/preview proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to preview' },
      { status: 502 }
    )
  }
}

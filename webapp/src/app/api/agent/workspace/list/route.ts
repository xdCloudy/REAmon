import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { guardProject } from '@/lib/access'


export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get('projectId')
  const __denied = await guardProject(projectId || '')
  if (__denied) return __denied
  const path = request.nextUrl.searchParams.get('path') ?? '.'

  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  }

  try {
    const url = `/workspace/list?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}`
    const resp = await agentFetch(url, { cache: 'no-store' })
    if (!resp.ok) {
      const text = await resp.text()
      return NextResponse.json({ error: text }, { status: resp.status })
    }
    return NextResponse.json(await resp.json())
  } catch (error) {
    console.error('workspace/list proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list workspace' },
      { status: 502 }
    )
  }
}

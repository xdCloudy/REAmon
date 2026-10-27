import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { guardProjectStrict } from '@/lib/access'


export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get('projectId')
  const __denied = await guardProjectStrict(projectId || '')
  if (__denied) return __denied
  const active = request.nextUrl.searchParams.get('active')  // 'true' | 'false' | null

  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  }

  try {
    let url = `/workspace/jobs?projectId=${encodeURIComponent(projectId)}`
    if (active !== null) url += `&active=${active}`
    const resp = await agentFetch(url, { cache: 'no-store' })
    if (!resp.ok) {
      const text = await resp.text()
      return NextResponse.json({ error: text }, { status: resp.status })
    }
    return NextResponse.json(await resp.json())
  } catch (error) {
    console.error('workspace/jobs proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch jobs' },
      { status: 502 }
    )
  }
}

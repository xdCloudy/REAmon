import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { guardProjectStrict } from '@/lib/access'

export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get('projectId') || ''
  const denied = await guardProjectStrict(projectId)
  if (denied) return denied

  try {
    const resp = await agentFetch(`/sessions?project_id=${encodeURIComponent(projectId)}`, { cache: 'no-store' })
    if (!resp.ok) {
      const text = await resp.text()
      return NextResponse.json({ error: text }, { status: resp.status })
    }
    return NextResponse.json(await resp.json())
  } catch (error) {
    console.error('Sessions proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch sessions' },
      { status: 502 }
    )
  }
}

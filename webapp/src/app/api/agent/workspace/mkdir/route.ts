import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { guardProject } from '@/lib/access'


export async function POST(request: NextRequest) {
  let body: { projectId?: string; path?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!body.projectId || !body.path) {
    return NextResponse.json({ error: 'projectId, path required' }, { status: 400 })
  }
  const __denied = await guardProject(body.projectId || '')
  if (__denied) return __denied

  try {
    const resp = await agentFetch(`/workspace/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await resp.json()
    return NextResponse.json(data, { status: resp.status })
  } catch (error) {
    console.error('workspace/mkdir proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to mkdir' },
      { status: 502 }
    )
  }
}

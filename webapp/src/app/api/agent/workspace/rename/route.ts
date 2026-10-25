import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { guardProject } from '@/lib/access'


export async function POST(request: NextRequest) {
  let body: { projectId?: string; path?: string; newName?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  if (!body.projectId || !body.path || !body.newName) {
    return NextResponse.json({ error: 'projectId, path, newName required' }, { status: 400 })
  }
  const __denied = await guardProject(body.projectId || '')
  if (__denied) return __denied

  try {
    const resp = await agentFetch(`/workspace/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const text = await resp.text()
      return NextResponse.json({ error: text }, { status: resp.status })
    }
    return NextResponse.json(await resp.json())
  } catch (error) {
    console.error('workspace/rename proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to rename' },
      { status: 502 }
    )
  }
}

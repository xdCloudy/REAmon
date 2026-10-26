import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { guardProjectStrict } from '@/lib/access'


export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const projectId = request.nextUrl.searchParams.get('projectId') || ''
  const denied = await guardProjectStrict(projectId)
  if (denied) return denied

  const { id } = await params
  try {
    const resp = await agentFetch(`/jobs/${id}/kill?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
    })
    if (!resp.ok) {
      const text = await resp.text()
      return NextResponse.json({ error: text }, { status: resp.status })
    }
    return NextResponse.json(await resp.json())
  } catch (error) {
    console.error('Job kill proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to kill job' },
      { status: 502 }
    )
  }
}

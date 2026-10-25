import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { guardProject } from '@/lib/access'


export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params
  const projectId = request.nextUrl.searchParams.get('projectId')
  const __denied = await guardProject(projectId || '')
  if (__denied) return __denied

  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  }
  if (!jobId) {
    return NextResponse.json({ error: 'jobId required' }, { status: 400 })
  }

  try {
    const url = `/workspace/jobs/${encodeURIComponent(jobId)}/cancel?projectId=${encodeURIComponent(projectId)}`
    const resp = await agentFetch(url, { method: 'POST' })
    if (!resp.ok) {
      const text = await resp.text()
      return NextResponse.json({ error: text }, { status: resp.status })
    }
    return NextResponse.json(await resp.json())
  } catch (error) {
    console.error('workspace/jobs/cancel proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to cancel job' },
      { status: 502 }
    )
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { guardProject } from '@/lib/access'


// Increase body size limit so this proxy can stream large uploads.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  // Pass the original multipart body straight through; FastAPI parses it.
  const formData = await request.formData()
  const projectId = formData.get('projectId')
  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 })
  }
  const __denied = await guardProject(String(projectId))
  if (__denied) return __denied
  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file required' }, { status: 400 })
  }

  try {
    // Re-encode as multipart for upstream. fetch() handles this for FormData.
    const resp = await agentFetch(
      '/workspace/upload',
      { method: 'POST', body: formData },
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

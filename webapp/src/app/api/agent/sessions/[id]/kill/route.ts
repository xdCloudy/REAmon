import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'


export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const resp = await agentFetch(`/sessions/${id}/kill`, {
      method: 'POST',
    })
    if (!resp.ok) {
      const text = await resp.text()
      return NextResponse.json({ error: text }, { status: resp.status })
    }
    return NextResponse.json(await resp.json())
  } catch (error) {
    console.error('Session kill proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to kill session' },
      { status: 502 }
    )
  }
}

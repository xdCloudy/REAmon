import { NextRequest, NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'


export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const body = await request.json()
    const resp = await agentFetch(`/sessions/${id}/interact`, {
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
    console.error('Session interact proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to interact with session' },
      { status: 502 }
    )
  }
}

import { NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { requireAdmin } from '@/lib/session'


export async function GET() {
  const auth = await requireAdmin()
  if (auth instanceof NextResponse) return auth

  try {
    const resp = await agentFetch(`/sessions`, { cache: 'no-store' })
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

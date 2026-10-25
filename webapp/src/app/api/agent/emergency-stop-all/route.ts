import { NextResponse } from 'next/server'
import { agentFetch } from '@/lib/agentFetch'
import { requireAdmin } from '@/lib/session'

export async function POST() {
  const admin = await requireAdmin()
  if (admin instanceof NextResponse) return admin

  try {
    // D7/S8: /emergency-stop-all now requires internal auth; present the master
    // INTERNAL_API_KEY the webapp already holds.
    const response = await agentFetch('/emergency-stop-all', {
      method: 'POST',
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      return NextResponse.json(
        { error: errorData.detail || 'Failed to stop agents' },
        { status: response.status }
      )
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error) {
    console.error('Emergency stop-all error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}

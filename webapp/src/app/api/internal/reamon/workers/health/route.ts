import { NextRequest, NextResponse } from 'next/server'
import { isInternalRequest } from '@/lib/session'
import { getWorkerHeartbeatStatus } from '@/lib/reamon/worker-health'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  if (!isInternalRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workerId = request.nextUrl.searchParams.get('workerId')?.trim() || ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerId)) {
    return NextResponse.json({ error: 'workerId must be a bounded identifier' }, { status: 400 })
  }

  try {
    const health = await getWorkerHeartbeatStatus(workerId)
    return NextResponse.json(health, {
      status: health.healthy ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('Failed to read REAmon worker heartbeat:', error)
    return NextResponse.json({ error: 'Failed to read worker heartbeat' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}

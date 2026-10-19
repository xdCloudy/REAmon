import { NextRequest, NextResponse } from 'next/server'
import { isInternalRequest } from '@/lib/session'
import { recordWorkerHeartbeat } from '@/lib/reamon/worker-health'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  if (!isInternalRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 })
  }

  const workerId = Reflect.get(body, 'workerId')
  if (typeof workerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerId.trim())) {
    return NextResponse.json({ error: 'workerId must be a bounded identifier' }, { status: 400 })
  }

  try {
    await recordWorkerHeartbeat(workerId.trim())
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('Failed to record REAmon worker heartbeat:', error)
    return NextResponse.json({ error: 'Failed to record worker heartbeat' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { isInternalRequest } from '@/lib/session'
import { dispatchQueuedCodeRewrites } from '@/lib/reamon/code-rewrite-jobs'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  if (!isInternalRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let body: Record<string, unknown> = {}
  try {
    const parsed = await request.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 })
    }
    body = parsed as Record<string, unknown>
  } catch {
    // Empty bodies use the bounded default worker identity and batch size.
  }

  if (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isFinite(body.limit))) {
    return NextResponse.json({ error: 'limit must be a number' }, { status: 400 })
  }
  if (body.workerId !== undefined && (typeof body.workerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.workerId.trim()))) {
    return NextResponse.json({ error: 'workerId must be a bounded identifier' }, { status: 400 })
  }

  try {
    const result = await dispatchQueuedCodeRewrites({
      limit: body.limit as number | undefined,
      workerId: body.workerId as string | undefined,
    })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('Failed to dispatch REAmon code rewrites:', error)
    return NextResponse.json({ error: 'Failed to dispatch code rewrite jobs' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

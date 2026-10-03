import { NextRequest, NextResponse } from 'next/server'
import { isInternalRequest } from '@/lib/session'
import { applyImportRetention } from '@/lib/reamon/import-retention'

export const runtime = 'nodejs'

interface RetentionBody {
  projectId?: unknown
  apply?: unknown
}

export async function POST(request: NextRequest) {
  if (!isInternalRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    let body: RetentionBody = {}
    try {
      const parsed = await request.json()
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return NextResponse.json({ error: 'Request body must be an object' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
      }
      body = parsed as RetentionBody
    } catch {
      // Empty bodies intentionally perform a dry run.
    }

    let projectId: string | undefined
    if (body.projectId !== undefined) {
      if (typeof body.projectId !== 'string' || !body.projectId.trim() || body.projectId.length > 128) {
        return NextResponse.json({ error: 'projectId must be a bounded string' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
      }
      projectId = body.projectId.trim()
    }
    if (body.apply !== undefined && typeof body.apply !== 'boolean') {
      return NextResponse.json({ error: 'apply must be a boolean' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }

    const result = await applyImportRetention({ projectId, dryRun: body.apply !== true })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('Failed to run REAmon import retention:', error)
    return NextResponse.json({ error: 'Failed to run import retention' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

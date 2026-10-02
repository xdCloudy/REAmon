import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { isInternalRequest } from '@/lib/session'

export const runtime = 'nodejs'

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
const MAX_OFFSET = 1_000_000

interface BackfillBody {
  limit?: unknown
  offset?: unknown
}

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
}

function bounded(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) return -1
  if (value < 0) return -1
  return Math.min(max, Math.floor(value))
}

export async function POST(request: NextRequest) {
  if (!isInternalRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: BackfillBody = {}
  try {
    const parsed = await request.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return badRequest('Request body must be an object')
    body = parsed as BackfillBody
  } catch {
    // Bounded defaults make an empty internal request safe.
  }

  const limit = bounded(body.limit, DEFAULT_LIMIT, MAX_LIMIT)
  const offset = bounded(body.offset, 0, MAX_OFFSET)
  if (limit < 1) return badRequest('limit must be a positive number')
  if (offset < 0) return badRequest('offset must be a non-negative number')

  try {
    const rows = await prisma.project.findMany({
      where: { observations: { some: {} } },
      orderBy: { id: 'asc' },
      skip: offset,
      take: limit + 1,
      select: { id: true },
    })
    const truncated = rows.length > limit
    const projects = rows.slice(0, limit).map((row) => row.id)
    return NextResponse.json({
      offset,
      projects,
      truncated,
      nextOffset: truncated ? offset + projects.length : null,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('Failed to list REAmon graph backfill projects:', error)
    return NextResponse.json({ error: 'Failed to list graph backfill projects' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

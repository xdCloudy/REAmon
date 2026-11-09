import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccessStrict } from '@/lib/access'
import { McpToolError } from '@/lib/mcp/errors'
import type { McpContext } from '@/lib/mcp/tools'
import { listWorkspaceCodeUnits } from '@/lib/mcp/workspaceCodeTools'

interface RouteParams { params: Promise<{ id: string }> }

function errorResponse(error: unknown) {
  if (error instanceof McpToolError) {
    const status = error.code === 'not_found' ? 404
      : error.code === 'rate_limited' ? 429
        : error.code === 'cursor_unavailable' ? 503
          : error.code === 'stale_snapshot' ? 409
            : 400
    return NextResponse.json({ error: { code: error.code, message: error.message } }, {
      status,
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
  console.error('Failed to list REAmon workspace code units:', error)
  return NextResponse.json({ error: 'Failed to list workspace code units' }, { status: 500, headers: { 'Cache-Control': 'private, no-store' } })
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccessStrict(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const url = new URL(request.url)
    const search = url.searchParams.get('search') ?? undefined
    const taskId = url.searchParams.get('taskId') ?? undefined
    const rawLimit = url.searchParams.get('limit')
    const limit = rawLimit == null ? undefined : Number(rawLimit)
    const rawOffset = url.searchParams.get('offset')
    const offset = rawOffset == null ? undefined : Number(rawOffset)
    const cursor = url.searchParams.get('cursor') ?? undefined
    if (search !== undefined && search.length > 200) {
      return NextResponse.json({ error: 'search must be at most 200 characters' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }
    if (taskId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) {
      return NextResponse.json({ error: 'taskId must be an alphanumeric id of at most 64 characters' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      return NextResponse.json({ error: 'limit must be an integer between 1 and 100' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)) {
      return NextResponse.json({ error: 'offset must be an integer between 0 and 100000' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }
    if (cursor !== undefined && (cursor.length > 2048 || offset !== undefined)) {
      return NextResponse.json({ error: 'cursor must be at most 2048 characters and cannot be combined with offset' }, { status: 400, headers: { 'Cache-Control': 'private, no-store' } })
    }

    const ctx: McpContext = { token: {
      tokenId: `browser:${effectiveUser.userId}`,
      userId: effectiveUser.userId,
      tokenPrefix: 'browser-session',
      name: 'Browser workspace read',
      scopes: ['recon:read'],
    } }
    const result = await listWorkspaceCodeUnits(ctx, {
      projectId,
      ...(search !== undefined ? { search } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    return errorResponse(error)
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { isInternalRequest } from '@/lib/session'
import { verifyTag } from '@/lib/redamonCtx'
import prisma from '@/lib/prisma'
import { listWorkspaceCodeUnits, getWorkspaceCodeUnit, listWorkspaceCodeRelationships } from '@/lib/mcp/workspaceCodeTools'
import type { McpContext } from '@/lib/mcp/tools'
import { McpToolError } from '@/lib/mcp/errors'

export const runtime = 'nodejs'

const ALLOWED_TOOLS = new Set(['workspace_list_code_units', 'workspace_get_code_unit', 'workspace_list_code_relationships'])
export async function POST(request: NextRequest) {
  if (!isInternalRequest(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const secret = process.env.INTERNAL_API_KEY
  const scope = verifyTag(request.headers.get('x-redamon-ctx') || '', secret || '')
  const now = Math.floor(Date.now() / 1000)
  if (!scope || scope.source !== 'agent' || typeof scope.project_id !== 'string'
      || !scope.project_id || scope.project_id.length > 255 || typeof scope.user_id !== 'string'
      || !scope.user_id || scope.user_id.length > 255 || typeof scope.exp !== 'number'
      || !Number.isInteger(scope.exp) || scope.exp <= now || scope.exp > now + 300
      || typeof scope.tool !== 'string' || !ALLOWED_TOOLS.has(scope.tool)) {
    return NextResponse.json({ error: 'Invalid or expired agent context' }, { status: 401 })
  }
  const rawBody = await request.text()
  if (Buffer.byteLength(rawBody, 'utf8') > 4096) return NextResponse.json({ error: 'Request body is too large' }, { status: 413 })

  try {
    let body: unknown
    try { body = JSON.parse(rawBody) } catch { return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 }) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 })
    const input = body as Record<string, unknown>
    if (input.tool !== scope.tool) return NextResponse.json({ error: 'Tool context mismatch' }, { status: 403 })
    const list = scope.tool === 'workspace_list_code_units'
    const relationshipList = scope.tool === 'workspace_list_code_relationships'
    const allowedKeys = list
      ? new Set(['tool', 'search', 'taskId', 'limit', 'offset', 'cursor'])
      : relationshipList
        ? new Set(['tool', 'codeUnitId', 'relationshipKind', 'direction', 'limit', 'offset', 'cursor'])
        : new Set(['tool', 'codeUnitId', 'sourceOffsetBytes', 'sourceSnapshotHash'])
    if (Object.keys(input).some(key => !allowedKeys.has(key))) return NextResponse.json({ error: 'Unsupported workspace code-unit argument' }, { status: 400 })
    if (list && ((input.search !== undefined && typeof input.search !== 'string')
        || (input.taskId !== undefined && typeof input.taskId !== 'string')
        || (input.limit !== undefined && typeof input.limit !== 'number')
        || (input.offset !== undefined && typeof input.offset !== 'number')
        || (input.cursor !== undefined && typeof input.cursor !== 'string'))) {
      return NextResponse.json({ error: 'Invalid code-unit pagination arguments' }, { status: 400 })
    }
    if (relationshipList && (typeof input.codeUnitId !== 'string'
        || (input.relationshipKind !== 'calls' && input.relationshipKind !== 'references')
        || (input.direction !== undefined && input.direction !== 'both' && input.direction !== 'incoming' && input.direction !== 'outgoing')
        || (input.limit !== undefined && typeof input.limit !== 'number')
        || (input.offset !== undefined && typeof input.offset !== 'number')
        || (input.cursor !== undefined && typeof input.cursor !== 'string'))) {
      return NextResponse.json({ error: 'Invalid code-relationship pagination arguments' }, { status: 400 })
    }
    if (!list && (typeof input.codeUnitId !== 'string'
        || (input.sourceOffsetBytes !== undefined && typeof input.sourceOffsetBytes !== 'number')
        || (input.sourceSnapshotHash !== undefined && typeof input.sourceSnapshotHash !== 'string'))) {
      return NextResponse.json({ error: 'Invalid code-unit detail arguments' }, { status: 400 })
    }
    if (list && ((typeof input.search === 'string' && input.search.length > 200) || (typeof input.taskId === 'string' && input.taskId.length > 64)
        || (input.limit as number | undefined) !== undefined && (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100)
        || (input.offset as number | undefined) !== undefined && (!Number.isInteger(input.offset) || (input.offset as number) < 0 || (input.offset as number) > 100000)
        || (input.cursor as string | undefined) !== undefined && ((input.cursor as string).length > 2048 || input.offset !== undefined))) {
      return NextResponse.json({ error: 'Code-unit pagination is outside supported bounds' }, { status: 400 })
    }
    if (relationshipList && ((input.codeUnitId as string).length > 64
        || (input.limit as number | undefined) !== undefined && (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100)
        || (input.offset as number | undefined) !== undefined && (!Number.isInteger(input.offset) || (input.offset as number) < 0 || (input.offset as number) > 100000)
        || (input.cursor as string | undefined) !== undefined && ((input.cursor as string).length > 2048 || input.offset !== undefined))) {
      return NextResponse.json({ error: 'Code-relationship pagination is outside supported bounds' }, { status: 400 })
    }
    if (!list && ((input.codeUnitId as string).length > 64
        || (input.sourceOffsetBytes as number | undefined) !== undefined && (!Number.isSafeInteger(input.sourceOffsetBytes) || (input.sourceOffsetBytes as number) < 0 || (input.sourceOffsetBytes as number) > 128 * 1024 * 1024)
        || typeof input.sourceSnapshotHash === 'string' && !/^[a-f0-9]{64}$/i.test(input.sourceSnapshotHash))) {
      return NextResponse.json({ error: 'Code-unit detail is outside supported bounds' }, { status: 400 })
    }

    const project = await prisma.project.findFirst({ where: { id: scope.project_id, userId: scope.user_id }, select: { id: true } })
    if (!project) return NextResponse.json({ error: 'Project not found for this agent context' }, { status: 404 })
    // This context is created only after validating the agent-signed owner and project above.
    // The delegated MCP reader repeats project ownership checks and applies its read rate limit.
    const ctx: McpContext = { token: {
      tokenId: `agent:${scope.user_id}:${project.id}`,
      userId: scope.user_id,
      tokenPrefix: 'agent-internal',
      name: 'Internal agent workspace read',
      scopes: ['recon:read'],
    } }
    const args = { projectId: project.id }
    let result
    if (list) {
      result = await listWorkspaceCodeUnits(ctx, {
        ...args,
        ...(input.search !== undefined ? { search: input.search as string } : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId as string } : {}),
        ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
        ...(input.offset !== undefined ? { offset: input.offset as number } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor as string } : {}),
      })
    } else if (relationshipList) {
      result = await listWorkspaceCodeRelationships(ctx, {
        ...args,
        codeUnitId: input.codeUnitId as string,
        relationshipKind: input.relationshipKind as 'calls' | 'references',
        ...(input.direction !== undefined ? { direction: input.direction as 'both' | 'incoming' | 'outgoing' } : {}),
        ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
        ...(input.offset !== undefined ? { offset: input.offset as number } : {}),
        ...(input.cursor !== undefined ? { cursor: input.cursor as string } : {}),
      })
    } else {
      result = await getWorkspaceCodeUnit(ctx, {
        ...args,
        codeUnitId: input.codeUnitId as string,
        ...(input.sourceOffsetBytes !== undefined ? { sourceOffsetBytes: input.sourceOffsetBytes as number } : {}),
        ...(input.sourceSnapshotHash !== undefined ? { sourceSnapshotHash: input.sourceSnapshotHash as string } : {}),
      })
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof McpToolError) {
      const status = error.code === 'not_found' ? 404 : error.code === 'rate_limited' ? 429 : error.code === 'cursor_unavailable' ? 503 : error.code === 'stale_source' || error.code === 'stale_snapshot' ? 409 : 400
      return NextResponse.json({ error: error.message, code: error.code }, { status, headers: { 'Cache-Control': 'no-store' } })
    }
    console.error('Failed to read agent workspace code units:', error)
    return NextResponse.json({ error: 'Workspace code-unit service unavailable' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

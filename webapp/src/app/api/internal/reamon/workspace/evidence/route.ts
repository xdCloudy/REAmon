import { NextRequest, NextResponse } from 'next/server'
import { isInternalRequest } from '@/lib/session'
import { verifyTag } from '@/lib/redamonCtx'
import prisma from '@/lib/prisma'
import {
  listPersistedWorkspaceEvidence,
  readPersistedWorkspaceEvidence,
  WorkspaceEvidenceError,
} from '@/lib/reamon/workspace-evidence'

export const runtime = 'nodejs'

const ALLOWED_TOOLS = new Set(['workspace_list_evidence', 'workspace_get_evidence'])

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
  if (Buffer.byteLength(rawBody, 'utf8') > 4096) {
    return NextResponse.json({ error: 'Request body is too large' }, { status: 413 })
  }

  try {
    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 })
    }
    const input = body as Record<string, unknown>
    if (input.tool !== scope.tool) return NextResponse.json({ error: 'Tool context mismatch' }, { status: 403 })
    const expectedKeys = scope.tool === 'workspace_list_evidence'
      ? new Set(['tool', 'artifactId', 'limit', 'cursor'])
      : new Set(['tool', 'evidenceId', 'offsetBytes', 'evidenceHash'])
    if (Object.keys(input).some(key => !expectedKeys.has(key))) {
      return NextResponse.json({ error: 'Unsupported workspace evidence argument' }, { status: 400 })
    }
    if (scope.tool === 'workspace_list_evidence'
        && ((input.artifactId !== undefined && typeof input.artifactId !== 'string')
          || (input.cursor !== undefined && typeof input.cursor !== 'string')
          || (input.limit !== undefined && typeof input.limit !== 'number'))) {
      return NextResponse.json({ error: 'Invalid workspace evidence pagination arguments' }, { status: 400 })
    }
    if (scope.tool === 'workspace_get_evidence'
        && (typeof input.evidenceId !== 'string'
          || (input.offsetBytes !== undefined && typeof input.offsetBytes !== 'number')
          || (input.evidenceHash !== undefined && typeof input.evidenceHash !== 'string'))) {
      return NextResponse.json({ error: 'Invalid workspace evidence detail arguments' }, { status: 400 })
    }

    const project = await prisma.project.findFirst({
      where: { id: scope.project_id, userId: scope.user_id },
      select: { id: true },
    })
    if (!project) return NextResponse.json({ error: 'Project not found for this agent context' }, { status: 404 })

    const result = scope.tool === 'workspace_list_evidence'
      ? await listPersistedWorkspaceEvidence({
          projectId: project.id,
          ...(input.artifactId !== undefined ? { artifactId: input.artifactId as string } : {}),
          ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
          ...(input.cursor !== undefined ? { cursor: input.cursor as string } : {}),
        })
      : await readPersistedWorkspaceEvidence({
          projectId: project.id,
          evidenceId: input.evidenceId as string,
          ...(input.offsetBytes !== undefined ? { offsetBytes: input.offsetBytes as number } : {}),
          ...(input.evidenceHash !== undefined ? { evidenceHash: input.evidenceHash as string } : {}),
        })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof WorkspaceEvidenceError) {
      const status = error.code === 'not_found' ? 404
        : error.code === 'too_large' ? 413
          : error.code === 'stale_snapshot' ? 409
            : error.code === 'cursor_unavailable' ? 503
              : 400
      return NextResponse.json({ error: error.message, code: error.code }, { status, headers: { 'Cache-Control': 'no-store' } })
    }
    console.error('Failed to read agent workspace evidence:', error)
    return NextResponse.json({ error: 'Workspace evidence service unavailable' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

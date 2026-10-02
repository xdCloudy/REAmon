import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { listWorkspaceFiles, type WorkspaceFileKind } from '@/lib/reamon/inventory-query'

interface RouteParams { params: Promise<{ id: string }> }

const KINDS = new Set<WorkspaceFileKind>(['executables', 'source'])

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const url = new URL(request.url)
    const rawKind = url.searchParams.get('kind') || undefined
    const kind = rawKind && KINDS.has(rawKind as WorkspaceFileKind) ? rawKind as WorkspaceFileKind : undefined
    if (rawKind && !kind) return NextResponse.json({ error: 'Unsupported workspace file kind' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    const rawLimit = url.searchParams.get('limit')
    const limit = rawLimit == null ? undefined : Number(rawLimit)
    if (limit != null && (!Number.isSafeInteger(limit) || limit < 1)) {
      return NextResponse.json({ error: 'limit must be a positive integer' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }

    const result = await listWorkspaceFiles(projectId, {
      search: url.searchParams.get('search') || undefined,
      format: url.searchParams.get('format') || undefined,
      kind,
      limit,
    })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to query REAmon workspace files:', error)
    return NextResponse.json({ error: 'Failed to query workspace files' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

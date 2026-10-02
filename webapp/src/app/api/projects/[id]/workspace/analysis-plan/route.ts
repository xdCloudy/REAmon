import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { listWorkspaceFiles, type WorkspaceFileKind } from '@/lib/reamon/inventory-query'
import { buildWorkspaceAnalysisPlan } from '@/lib/reamon/analysis-plan'

interface RouteParams { params: Promise<{ id: string }> }

const KINDS = new Set<WorkspaceFileKind>(['executables', 'source'])

function positiveInteger(value: string | null, label: string, max: number): number | undefined | NextResponse {
  if (value == null) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    return NextResponse.json({ error: `${label} must be an integer between 1 and ${max}` }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  return parsed
}

function nonNegativeInteger(value: string | null, label: string, max: number): number | undefined | NextResponse {
  if (value == null) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    return NextResponse.json({ error: `${label} must be a non-negative integer no greater than ${max}` }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  return parsed
}

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
    if (rawKind && !kind) return NextResponse.json({ error: 'Unsupported workspace analysis kind' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })

    const limit = positiveInteger(url.searchParams.get('limit'), 'limit', 100)
    if (limit instanceof NextResponse) return limit
    const offset = nonNegativeInteger(url.searchParams.get('offset'), 'offset', 100000)
    if (offset instanceof NextResponse) return offset

    const search = url.searchParams.get('search') || undefined
    const format = url.searchParams.get('format') || undefined
    const capability = url.searchParams.get('capability') || undefined
    if (search && search.length > 200) return NextResponse.json({ error: 'search must be at most 200 characters' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    if (format && format.length > 64) return NextResponse.json({ error: 'format must be at most 64 characters' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    if (capability && capability.length > 64) return NextResponse.json({ error: 'capability must be at most 64 characters' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })

    const query = { search, format, kind, capability, limit, offset }
    const inventory = await listWorkspaceFiles(projectId, { search, format, kind, limit, offset })
    const plan = buildWorkspaceAnalysisPlan(projectId, inventory, query)
    return NextResponse.json(plan, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to build REAmon workspace analysis plan:', error)
    return NextResponse.json({ error: 'Failed to build workspace analysis plan' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}


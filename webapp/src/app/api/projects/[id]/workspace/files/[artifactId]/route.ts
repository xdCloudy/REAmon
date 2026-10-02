import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getWorkspaceArtifact } from '@/lib/reamon/inventory-query'

interface RouteParams { params: Promise<{ id: string; artifactId: string }> }

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, artifactId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const artifact = await getWorkspaceArtifact(projectId, artifactId)
    if (!artifact) return NextResponse.json({ error: 'Workspace artifact not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    return NextResponse.json(artifact, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to load REAmon workspace artifact:', error)
    return NextResponse.json({ error: 'Failed to load workspace artifact' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

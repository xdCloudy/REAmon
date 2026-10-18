import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getWorkspaceArtifact } from '@/lib/reamon/inventory-query'
import { resolveCapabilities } from '@/lib/reamon/capabilities'
import { getBuiltinProvider } from '@/lib/reamon/provider-registry'
import type { TargetProfile } from '@/lib/reamon/types'

interface RouteParams { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    let body: { proposalId?: unknown; artifactId?: unknown; providerId?: unknown; capability?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const artifactId = typeof body.artifactId === 'string' ? body.artifactId.trim() : ''
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : ''
    const requestedCapability = typeof body.capability === 'string' ? body.capability.trim().toLowerCase() : ''
    const proposalId = typeof body.proposalId === 'string' ? body.proposalId.trim() : ''
    if (!artifactId || !providerId || !requestedCapability || !proposalId || proposalId.length > 512) {
      return NextResponse.json({ error: 'proposalId, artifactId, providerId, and capability are required' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }

    const artifact = await getWorkspaceArtifact(projectId, artifactId)
    if (!artifact) return NextResponse.json({ error: 'Workspace artifact not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    const provider = getBuiltinProvider(providerId)
    if (!provider) return NextResponse.json({ error: 'Provider not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    const match = resolveCapabilities(artifact.profile as TargetProfile, [provider])[0]
    const capability = match?.capabilities.find((candidate) => candidate.toLowerCase() === requestedCapability)
    if (!capability || proposalId !== `${artifactId}:${providerId}:${capability}`) {
      return NextResponse.json({ error: 'Proposal is not compatible with this artifact' }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
    }

    await prisma.workspaceActivity.create({
      data: {
        projectId,
        actor: effectiveUser.userId,
        eventType: 'analysis.proposal.cleared',
        message: `Cleared ${capability} for ${artifact.relativePath} from the proposal list`,
        data: { proposalId, artifactId, providerId, capability },
      },
    })
    return NextResponse.json({ cleared: true, proposalId }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('Failed to clear REAmon analysis proposal:', error)
    return NextResponse.json({ error: 'Failed to clear analysis proposal' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

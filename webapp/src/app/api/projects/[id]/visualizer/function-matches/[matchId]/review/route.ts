import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'

interface RouteParams { params: Promise<{ id: string; matchId: string }> }
const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, matchId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access
    const body = await request.json() as Record<string, unknown>
    const decision = typeof body.decision === 'string' ? body.decision.trim().toUpperCase() : ''
    const rationale = typeof body.rationale === 'string' ? body.rationale.trim() : ''
    if (!['ACCEPTED', 'REJECTED'].includes(decision) || rationale.length > 4000) {
      return NextResponse.json({ error: 'Choose accept or reject and keep the rationale under 4,000 characters.' }, { status: 400, headers: NO_STORE })
    }
    const match = await prisma.reamonFunctionMatch.findFirst({ where: { id: matchId, projectId }, select: { id: true } })
    if (!match) return NextResponse.json({ error: 'Function comparison not found' }, { status: 404, headers: NO_STORE })
    const review = await prisma.$transaction(async (tx) => {
      const created = await tx.reamonFunctionMatchReview.create({
        data: { projectId, matchId, decision, reviewerId: user.userId, rationale },
      })
      await tx.workspaceActivity.create({
        data: {
          projectId,
          actor: 'Operator',
          eventType: `native-function-match.${decision.toLowerCase()}`,
          message: `${decision === 'ACCEPTED' ? 'Accepted' : 'Rejected'} a proposed function match`,
          data: { matchId, reviewId: created.id, reviewerId: user.userId },
        },
      })
      return created
    })
    return NextResponse.json({ review }, { status: 201, headers: NO_STORE })
  } catch (error) {
    console.error('Could not save function match review:', error)
    return NextResponse.json({ error: 'Could not save this function match review' }, { status: 500, headers: NO_STORE })
  }
}

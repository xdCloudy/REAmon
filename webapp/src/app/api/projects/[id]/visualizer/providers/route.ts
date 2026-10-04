import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'

interface RouteParams { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const providers = await prisma.userLlmProvider.findMany({
      where: { userId: user.userId, providerType: 'openai_compatible' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, modelIdentifier: true },
    })
    return NextResponse.json({ providers }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to list code explanation providers:', error)
    return NextResponse.json({ error: 'Failed to load saved AI providers' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

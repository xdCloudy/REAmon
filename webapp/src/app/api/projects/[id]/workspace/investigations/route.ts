import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'

interface RouteParams { params: Promise<{ id: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 50
const MAX_ATTEMPTS_PER_CASE = 24
const RECENT_ATTEMPTS = 5

function pageSizeFromUrl(url: URL): number {
  const value = url.searchParams.get('limit')
  if (!value || !/^\d+$/.test(value)) return DEFAULT_PAGE_SIZE
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const url = new URL(request.url)
    const limit = pageSizeFromUrl(url)
    const cursor = url.searchParams.get('cursor')
    if (cursor && (cursor.length > 100 || !/^[\w-]+$/.test(cursor))) {
      return NextResponse.json({ error: 'Invalid investigation cursor' }, { status: 400, headers: NO_STORE })
    }
    if (cursor) {
      const cursorCase = await prisma.reamonInvestigationCase.findFirst({
        where: { id: cursor, projectId },
        select: { id: true },
      })
      if (!cursorCase) {
        return NextResponse.json({ error: 'Investigation cursor is unavailable in this project' }, { status: 400, headers: NO_STORE })
      }
    }

    const rows = await prisma.reamonInvestigationCase.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        taskId: true,
        artifactId: true,
        artifactSha256: true,
        capability: true,
        providerId: true,
        providerVersion: true,
        status: true,
        revision: true,
        createdAt: true,
        updatedAt: true,
        task: { select: { title: true, status: true, capability: true } },
      },
    })
    const hasMore = rows.length > limit
    const cases = rows.slice(0, limit)
    const attempts = cases.length ? await prisma.reamonCodeAttempt.findMany({
      where: {
        projectId,
        scope: 'manual-investigation',
        runKey: { in: cases.map((item) => item.taskId) },
        artifactId: { in: [...new Set(cases.map((item) => item.artifactId))] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: cases.length * MAX_ATTEMPTS_PER_CASE,
      select: {
        id: true,
        artifactId: true,
        runKey: true,
        codeUnitId: true,
        unitName: true,
        status: true,
        errorCode: true,
        validationStatus: true,
        resultSource: true,
        createdAt: true,
        completedAt: true,
      },
    }) : []

    const caseByTaskId = new Map(cases.map((item) => [item.taskId, item]))
    const attemptsByCase = new Map<string, typeof attempts>()
    for (const item of attempts) {
      const matchingCase = caseByTaskId.get(item.runKey)
      if (!matchingCase || matchingCase.artifactId !== item.artifactId
          || (item.codeUnitId !== `investigation:${matchingCase.id}` && !item.codeUnitId.startsWith(`investigation:${matchingCase.id}:unit:`))) continue
      const prior = attemptsByCase.get(matchingCase.id) ?? []
      prior.push(item)
      attemptsByCase.set(matchingCase.id, prior)
    }

    const investigationCases = cases.map((item) => {
      const caseAttempts = attemptsByCase.get(item.id) ?? []
      const latestAttempt = caseAttempts[0]
      return {
        id: item.id,
        taskId: item.taskId,
        artifactId: item.artifactId,
        artifactSha256: item.artifactSha256,
        capability: item.capability,
        providerId: item.providerId,
        providerVersion: item.providerVersion,
        status: latestAttempt?.status ?? item.status,
        revision: item.revision,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        task: item.task,
        attemptCount: caseAttempts.length,
        hasCandidate: caseAttempts.some((attempt) => typeof attempt.resultSource === 'string' && attempt.resultSource.length > 0),
        active: caseAttempts.some((attempt) => attempt.status === 'QUEUED' || attempt.status === 'RUNNING'),
        attempts: caseAttempts.slice(0, RECENT_ATTEMPTS).map(({ resultSource, ...attempt }) => ({
          ...attempt,
          candidateAvailable: typeof resultSource === 'string' && resultSource.length > 0,
        })),
      }
    })

    return NextResponse.json({
      investigations: investigationCases,
      nextCursor: hasMore ? cases[cases.length - 1]?.id ?? null : null,
    }, { headers: NO_STORE })
  } catch (error) {
    console.error('Failed to load REAmon project investigation queue:', error)
    return NextResponse.json({ error: 'Failed to load investigation queue' }, { status: 500, headers: NO_STORE })
  }
}

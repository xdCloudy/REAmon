import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  investigationFindMany: vi.fn(),
  codeAttemptFindMany: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    reamonInvestigationCase: { findMany: mocks.investigationFindMany },
    reamonCodeAttempt: { findMany: mocks.codeAttemptFindMany },
  },
}))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

import { GET } from './route'

const params = Promise.resolve({ id: 'project-1' })

describe('/api/projects/[id]/workspace/investigations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
    mocks.requireProjectAccess.mockResolvedValue({ projectId: 'project-1' })
    mocks.investigationFindMany.mockResolvedValue([])
    mocks.codeAttemptFindMany.mockResolvedValue([])
  })

  test('lists only project-scoped cases and returns bounded, resumable pages', async () => {
    const cases = Array.from({ length: 3 }, (_, index) => ({
      id: `case-${index + 1}`,
      taskId: `task-${index + 1}`,
      artifactId: 'artifact-1',
      artifactSha256: 'a'.repeat(64),
      capability: 'decompile',
      providerId: 'provider-1',
      providerVersion: '1.0',
      status: 'QUEUED',
      revision: 1,
      createdAt: new Date(`2026-10-2${index + 1}T00:00:00.000Z`),
      updatedAt: new Date(`2026-10-2${index + 1}T00:00:00.000Z`),
      task: { title: `failed run ${index + 1}`, status: 'FAILED', capability: 'decompile' },
    }))
    mocks.investigationFindMany.mockResolvedValue(cases)
    mocks.codeAttemptFindMany.mockResolvedValue([{
      id: 'attempt-1', artifactId: 'artifact-1', runKey: 'task-1',
      codeUnitId: 'investigation:case-1:unit:abc', unitName: 'decode_entry', status: 'SUCCEEDED',
      errorCode: null, validationStatus: 'UNAVAILABLE', resultSource: 'candidate source',
      createdAt: new Date('2026-10-29T00:00:00.000Z'), completedAt: new Date('2026-10-29T00:00:01.000Z'),
    }])

    const response = await GET(new Request('http://local?limit=2'), { params })

    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.investigations).toHaveLength(2)
    expect(payload.nextCursor).toBe('case-2')
    expect(payload.investigations[0]).toMatchObject({
      id: 'case-1', status: 'SUCCEEDED', attemptCount: 1, hasCandidate: true, active: false,
      attempts: [{ unitName: 'decode_entry', candidateAvailable: true }],
    })
    expect(payload.investigations[0].attempts[0]).not.toHaveProperty('resultSource')
    expect(payload.investigations[0]).not.toHaveProperty('failureEvidence')
    expect(mocks.investigationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'project-1' }, take: 3,
    }))
    expect(mocks.codeAttemptFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ projectId: 'project-1', scope: 'manual-investigation', runKey: { in: ['task-1', 'task-2'] } }),
      take: 48,
    }))
  })

  test('applies a stable cursor and caps requested page size', async () => {
    await GET(new Request('http://local?limit=999&cursor=case-7'), { params })

    expect(mocks.investigationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 51, cursor: { id: 'case-7' }, skip: 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }))
  })

  test('rejects malformed cursors without querying cases', async () => {
    const response = await GET(new Request('http://local?cursor=invalid.cursor'), { params })

    expect(response.status).toBe(400)
    expect(mocks.investigationFindMany).not.toHaveBeenCalled()
  })

  test('returns authorization responses without reading the project queue', async () => {
    mocks.requireEffectiveUser.mockResolvedValue(new NextResponse('Unauthorized', { status: 401 }))

    const response = await GET(new Request('http://local'), { params })

    expect(response.status).toBe(401)
    expect(mocks.investigationFindMany).not.toHaveBeenCalled()
  })

  test('does not list cases when the user lacks project access', async () => {
    mocks.requireProjectAccess.mockResolvedValue(new NextResponse('Not found', { status: 404 }))

    const response = await GET(new Request('http://local'), { params })

    expect(response.status).toBe(404)
    expect(mocks.investigationFindMany).not.toHaveBeenCalled()
  })
})

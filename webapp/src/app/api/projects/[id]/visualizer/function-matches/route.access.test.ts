import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  user: vi.fn(), access: vi.fn(),
  matchesFindMany: vi.fn(), matchesFindFirst: vi.fn(), matchesCreate: vi.fn(),
  taskFindFirst: vi.fn(), observationFindFirst: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: h.user,
  requireProjectAccessStrict: h.access,
}))
vi.mock('@/lib/prisma', () => ({ default: {
  reamonFunctionMatch: { findMany: h.matchesFindMany, findFirst: h.matchesFindFirst, create: h.matchesCreate },
  task: { findFirst: h.taskFindFirst },
  reamonObservation: { findFirst: h.observationFindFirst },
} }))

import { GET, POST } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }

describe('visualizer function match ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.user.mockResolvedValue({ userId: 'foreign-user' })
    h.access.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
  })

  it('denies saved match reads before querying comparisons', async () => {
    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/function-matches'), params)

    expect(response.status).toBe(404)
    expect(h.access).toHaveBeenCalledWith({ userId: 'foreign-user' }, 'project-1')
    expect(h.matchesFindMany).not.toHaveBeenCalled()
  })

  it('denies match creation before parsing input or loading runs', async () => {
    const response = await POST(new Request('http://localhost/api/projects/project-1/visualizer/function-matches', {
      method: 'POST', body: 'not-json',
    }), params)

    expect(response.status).toBe(404)
    expect(h.access).toHaveBeenCalledWith({ userId: 'foreign-user' }, 'project-1')
    expect(h.taskFindFirst).not.toHaveBeenCalled()
    expect(h.observationFindFirst).not.toHaveBeenCalled()
    expect(h.matchesFindFirst).not.toHaveBeenCalled()
    expect(h.matchesCreate).not.toHaveBeenCalled()
  })
})

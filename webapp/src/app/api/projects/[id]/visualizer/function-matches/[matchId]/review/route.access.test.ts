import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({ user: vi.fn(), access: vi.fn(), matchFindFirst: vi.fn(), transaction: vi.fn() }))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: h.user,
  requireProjectAccessStrict: h.access,
}))
vi.mock('@/lib/prisma', () => ({ default: {
  reamonFunctionMatch: { findFirst: h.matchFindFirst },
  $transaction: h.transaction,
} }))

import { POST } from './route'

describe('POST /api/projects/[id]/visualizer/function-matches/[matchId]/review ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.user.mockResolvedValue({ userId: 'foreign-user' })
    h.access.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
  })

  it('denies foreign review writes before looking up the match or creating audit records', async () => {
    const response = await POST(new Request('http://localhost/api/projects/project-1/visualizer/function-matches/match-1/review', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'ACCEPTED' }),
    }), { params: Promise.resolve({ id: 'project-1', matchId: 'match-1' }) })

    expect(response.status).toBe(404)
    expect(h.access).toHaveBeenCalledWith({ userId: 'foreign-user' }, 'project-1')
    expect(h.matchFindFirst).not.toHaveBeenCalled()
    expect(h.transaction).not.toHaveBeenCalled()
  })
})

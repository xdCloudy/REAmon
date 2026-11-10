/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({ user: vi.fn(), access: vi.fn(), strictAccess: vi.fn() }))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: h.user,
  requireProjectAccess: h.access,
  requireProjectAccessStrict: h.strictAccess,
}))
vi.mock('@/lib/prisma', () => ({ default: {} }))

import { GET } from './route'

describe('GET /api/projects/[id]/visualizer/similar-functions ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.user.mockResolvedValue({ userId: 'foreign-user' })
    h.access.mockResolvedValue({ project: { id: 'project-1', userId: 'project-owner' } })
    h.strictAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
  })

  it('denies foreign access before loading runs, code units, or neighboring evidence', async () => {
    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/similar-functions?taskId=task-1&unitId=unit-1'), {
      params: Promise.resolve({ id: 'project-1' }),
    })

    expect(response.status).toBe(404)
    expect(h.strictAccess).toHaveBeenCalledWith({ userId: 'foreign-user' }, 'project-1')
    expect(h.access).not.toHaveBeenCalled()
  })
})

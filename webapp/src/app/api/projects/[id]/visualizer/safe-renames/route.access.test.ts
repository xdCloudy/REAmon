/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  user: vi.fn(),
  access: vi.fn(),
  strictAccess: vi.fn(),
  findUnit: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: h.user,
  requireProjectAccess: h.access,
  requireProjectAccessStrict: h.strictAccess,
}))
vi.mock('@/lib/prisma', () => ({ default: { reamonObservation: { findFirst: h.findUnit } } }))

import { POST } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'foreign-user' })
  h.access.mockResolvedValue({ project: { id: 'project-1', userId: 'project-owner' } })
  h.strictAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
  h.findUnit.mockResolvedValue(null)
})

describe('POST /api/projects/[id]/visualizer/safe-renames ownership', () => {
  it('uses strict ownership before loading source units or invoking rename work', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'suggest', unitId: 'unit-1', providerId: 'provider-1' }),
    }), params)

    expect(response.status).toBe(404)
    expect(h.strictAccess).toHaveBeenCalledWith({ userId: 'foreign-user' }, 'project-1')
    expect(h.access).not.toHaveBeenCalled()
    expect(h.findUnit).not.toHaveBeenCalled()
  })
})

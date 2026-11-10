import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({ user: vi.fn(), strictAccess: vi.fn(), unitFindFirst: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ default: { reamonObservation: { findFirst: h.unitFindFirst } } }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccessStrict: h.strictAccess }))

import { GET, PATCH, PUT } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'foreign-user' })
  h.strictAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
})

describe('maintained Smali project ownership', () => {
  const params = { params: Promise.resolve({ id: 'project-1', unitId: 'private-unit' }) }

  it('denies foreign reads and writes before resolving the code unit', async () => {
    const get = await GET(new Request('http://localhost/api/projects/project-1/visualizer/maintained/private-unit/smali'), params)
    const patch = await PATCH(new Request('http://localhost/api/projects/project-1/visualizer/maintained/private-unit/smali', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCode: '.class Lx;' }),
    }), params)
    const put = await PUT(new Request('http://localhost/api/projects/project-1/visualizer/maintained/private-unit/smali', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceCode: '.class Lx;' }),
    }), params)

    expect([get.status, patch.status, put.status]).toEqual([404, 404, 404])
    expect(h.strictAccess).toHaveBeenCalledTimes(3)
    expect(h.unitFindFirst).not.toHaveBeenCalled()
  })
})

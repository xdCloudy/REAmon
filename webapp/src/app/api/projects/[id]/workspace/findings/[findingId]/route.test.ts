/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ requireEffectiveUser: vi.fn(), requireProjectAccess: vi.fn(), reviewFinding: vi.fn() }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: mocks.requireEffectiveUser, requireProjectAccess: mocks.requireProjectAccess }))
vi.mock('@/lib/reamon/finding-review', () => ({ isFindingStatus: (value: unknown) => ['OPEN', 'REVIEWING', 'ACCEPTED', 'REJECTED', 'VERIFIED'].includes(value), reviewFinding: mocks.reviewFinding }))

import { PATCH } from './route'

const params = { params: Promise.resolve({ id: 'project-1', findingId: 'finding-1' }) }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1' } })
  mocks.reviewFinding.mockResolvedValue({ finding: { id: 'finding-1', status: 'ACCEPTED' }, note: '' })
})

describe('PATCH /api/projects/[id]/workspace/findings/[findingId]', () => {
  test('enforces project access before reviewing', async () => {
    mocks.requireProjectAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
    const response = await PATCH(new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ status: 'ACCEPTED' }) }), params)
    expect(response.status).toBe(404)
    expect(mocks.reviewFinding).not.toHaveBeenCalled()
  })

  test('reviews a finding with a bounded note', async () => {
    const response = await PATCH(new Request('http://localhost', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ACCEPTED', note: 'Confirmed' }) }), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ finding: { id: 'finding-1', status: 'ACCEPTED' } })
    expect(mocks.reviewFinding).toHaveBeenCalledWith('project-1', 'finding-1', 'ACCEPTED', 'user-1', 'Confirmed')
  })
})

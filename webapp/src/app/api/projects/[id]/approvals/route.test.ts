/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccessStrict: vi.fn(),
  listTaskApprovals: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccessStrict: mocks.requireProjectAccessStrict,
}))
vi.mock('@/lib/reamon/task-approval', () => ({
  listTaskApprovals: mocks.listTaskApprovals,
}))

import { GET } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.ACCESS_ENFORCE
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'owner' })
  mocks.requireProjectAccessStrict.mockResolvedValue({ project: { id: 'project-1' } })
  mocks.listTaskApprovals.mockResolvedValue([])
})

describe('GET /api/projects/[id]/approvals', () => {
  test('anonymous caller receives 401 before project access or listing', async () => {
    mocks.requireEffectiveUser.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

    const response = await GET(new Request('http://localhost'), params)

    expect(response.status).toBe(401)
    expect(mocks.requireProjectAccessStrict).not.toHaveBeenCalled()
    expect(mocks.listTaskApprovals).not.toHaveBeenCalled()
  })

  test('foreign project caller is denied before listing with rollout disabled', async () => {
    process.env.ACCESS_ENFORCE = '0'
    mocks.requireProjectAccessStrict.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))

    const response = await GET(new Request('http://localhost'), params)

    expect(response.status).toBe(404)
    expect(mocks.listTaskApprovals).not.toHaveBeenCalled()
  })

  test('owner receives project-scoped approvals with optional status filter', async () => {
    mocks.listTaskApprovals.mockResolvedValue([{ approval: { id: 'approval-1' }, task: { id: 'task-1' } }])

    const response = await GET(new Request('http://localhost?status=pending'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ approvals: [{ approval: { id: 'approval-1' }, task: { id: 'task-1' } }] })
    expect(mocks.listTaskApprovals).toHaveBeenCalledWith('project-1', 'PENDING')
  })
})

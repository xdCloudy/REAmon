/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  decideTaskApproval: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))
vi.mock('@/lib/reamon/task-approval', () => ({ decideTaskApproval: mocks.decideTaskApproval }))

import { POST } from './route'

const params = { params: Promise.resolve({ id: 'project-1', approvalId: 'approval-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'operator-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1' } })
  mocks.decideTaskApproval.mockResolvedValue({
    outcome: 'APPROVED',
    approval: { id: 'approval-1', status: 'APPROVED' },
    task: { id: 'task-1', status: 'QUEUED' },
  })
})

describe('POST /api/projects/[id]/approvals/[approvalId]', () => {
  test('enforces project access before deciding', async () => {
    mocks.requireProjectAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))

    const response = await POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ decision: 'approve' }) }), params)

    expect(response.status).toBe(404)
    expect(mocks.decideTaskApproval).not.toHaveBeenCalled()
  })

  test('validates and persists the operator decision', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', reason: 'Reviewed against the stored artifact' }),
    }), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ decision: 'approve', approval: { status: 'APPROVED' }, task: { status: 'QUEUED' } })
    expect(mocks.decideTaskApproval).toHaveBeenCalledWith('project-1', 'approval-1', 'approve', 'operator-1', 'Reviewed against the stored artifact')
  })

  test('rejects unsupported decisions', async () => {
    const response = await POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ decision: 'maybe' }) }), params)

    expect(response.status).toBe(400)
    expect(mocks.decideTaskApproval).not.toHaveBeenCalled()
  })
})

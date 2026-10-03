/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  cancelAnalysisTask: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))
vi.mock('@/lib/reamon/task-control', () => ({ cancelAnalysisTask: mocks.cancelAnalysisTask }))

import { POST } from './route'

const params = { params: Promise.resolve({ id: 'project-1', taskId: 'task-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1' } })
  mocks.cancelAnalysisTask.mockResolvedValue({ outcome: 'CANCELLED', task: { id: 'task-1', status: 'CANCELLED' } })
})

describe('POST /api/projects/[id]/workspace/tasks/[taskId]/cancel', () => {
  test('enforces project access before cancelling', async () => {
    mocks.requireProjectAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))

    const response = await POST(new Request('http://localhost', { method: 'POST' }), params)

    expect(response.status).toBe(404)
    expect(mocks.cancelAnalysisTask).not.toHaveBeenCalled()
  })

  test('cancels queued or running work', async () => {
    const response = await POST(new Request('http://localhost', { method: 'POST' }), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ cancelled: true, task: { id: 'task-1', status: 'CANCELLED' } })
    expect(mocks.cancelAnalysisTask).toHaveBeenCalledWith('project-1', 'task-1')
  })

  test('rejects a task that is already complete', async () => {
    mocks.cancelAnalysisTask.mockResolvedValue({ outcome: 'SKIPPED', task: { id: 'task-1', status: 'COMPLETED' } })

    const response = await POST(new Request('http://localhost', { method: 'POST' }), params)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'Only queued, awaiting-approval, or running tasks can be cancelled' })
  })
})

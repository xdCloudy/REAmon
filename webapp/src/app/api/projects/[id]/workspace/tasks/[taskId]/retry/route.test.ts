/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  retryAnalysisTask: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))
vi.mock('@/lib/reamon/task-control', () => ({ retryAnalysisTask: mocks.retryAnalysisTask }))

import { POST } from './route'

const params = { params: Promise.resolve({ id: 'project-1', taskId: 'task-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1' } })
  mocks.retryAnalysisTask.mockResolvedValue({ outcome: 'REQUEUED', task: { id: 'task-1', status: 'QUEUED' } })
})

describe('POST /api/projects/[id]/workspace/tasks/[taskId]/retry', () => {
  test('enforces project access before retrying', async () => {
    mocks.requireProjectAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))

    const response = await POST(new Request('http://localhost', { method: 'POST' }), params)

    expect(response.status).toBe(404)
    expect(mocks.retryAnalysisTask).not.toHaveBeenCalled()
  })

  test('requeues a failed task', async () => {
    const response = await POST(new Request('http://localhost', { method: 'POST' }), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ retried: true, task: { id: 'task-1', status: 'QUEUED' } })
    expect(mocks.retryAnalysisTask).toHaveBeenCalledWith('project-1', 'task-1')
  })

  test('rejects a task that is no longer retryable', async () => {
    mocks.retryAnalysisTask.mockResolvedValue({ outcome: 'SKIPPED', task: { id: 'task-1', status: 'RUNNING' } })

    const response = await POST(new Request('http://localhost', { method: 'POST' }), params)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'Only failed or cancelled tasks can be retried' })
  })
})

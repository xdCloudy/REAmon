/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  executeAnalysisTask: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))
vi.mock('@/lib/reamon/task-executor', () => ({ executeAnalysisTask: mocks.executeAnalysisTask }))

import { POST } from './route'

const params = { params: Promise.resolve({ id: 'project-1', taskId: 'task-1' }) }
const completed = {
  outcome: 'COMPLETED',
  task: { id: 'task-1', projectId: 'project-1', status: 'COMPLETED', progress: 100, result: { strings: ['hello'] }, error: '' },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.executeAnalysisTask.mockResolvedValue(completed)
})

describe('POST /api/projects/[id]/workspace/tasks/[taskId]/execute', () => {
  test('enforces project access before executing a task', async () => {
    mocks.requireProjectAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))

    const response = await POST(new Request('http://localhost', { method: 'POST' }), params)

    expect(response.status).toBe(404)
    expect(mocks.executeAnalysisTask).not.toHaveBeenCalled()
  })

  test('executes an authorized task and returns its durable outcome', async () => {
    const response = await POST(new Request('http://localhost', { method: 'POST' }), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(completed)
    expect(mocks.executeAnalysisTask).toHaveBeenCalledWith('project-1', 'task-1')
  })

  test('returns not found without revealing another task', async () => {
    mocks.executeAnalysisTask.mockResolvedValue(null)

    const response = await POST(new Request('http://localhost', { method: 'POST' }), params)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Workspace task not found' })
  })

  test('reports a concurrent execution instead of running twice', async () => {
    mocks.executeAnalysisTask.mockResolvedValue({ outcome: 'SKIPPED', task: { ...completed.task, status: 'RUNNING' } })

    const response = await POST(new Request('http://localhost', { method: 'POST' }), params)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'Task is already running', task: { status: 'RUNNING' } })
  })
})

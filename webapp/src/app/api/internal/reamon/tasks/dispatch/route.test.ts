/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  recoverStaleAnalysisTasks: vi.fn(),
  dispatchQueuedAnalysisTasks: vi.fn(),
  internal: vi.fn(),
}))

vi.mock('@/lib/session', () => ({ isInternalRequest: mocks.internal }))
vi.mock('@/lib/reamon/task-control', () => ({ recoverStaleAnalysisTasks: mocks.recoverStaleAnalysisTasks }))
vi.mock('@/lib/reamon/task-dispatcher', () => ({ dispatchQueuedAnalysisTasks: mocks.dispatchQueuedAnalysisTasks }))

import { POST } from './route'

const taskResult = { outcome: 'COMPLETED', task: { id: 'task-1', status: 'COMPLETED' } }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.internal.mockReturnValue(true)
  mocks.recoverStaleAnalysisTasks.mockResolvedValue({ recovered: 1, staleAfterMinutes: 30 })
  mocks.dispatchQueuedAnalysisTasks.mockResolvedValue({ requested: 2, selected: 1, results: [taskResult] })
})

describe('POST /api/internal/reamon/tasks/dispatch', () => {
  test('requires the internal worker key', async () => {
    mocks.internal.mockReturnValue(false)

    const response = await POST(new Request('http://localhost', { method: 'POST' }) as never)

    expect(response.status).toBe(401)
    expect(mocks.dispatchQueuedAnalysisTasks).not.toHaveBeenCalled()
  })

  test('recovers and dispatches a bounded project-scoped batch', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'project-1', limit: 2, staleAfterMinutes: 45 }),
      headers: { 'Content-Type': 'application/json' },
    }) as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ recovered: 1, requested: 2, selected: 1, results: [taskResult] })
    expect(mocks.recoverStaleAnalysisTasks).toHaveBeenCalledWith('project-1', 45)
    expect(mocks.dispatchQueuedAnalysisTasks).toHaveBeenCalledWith({ projectId: 'project-1', limit: 2 })
  })

  test('rejects malformed worker input', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ limit: '2' }),
    }) as never)

    expect(response.status).toBe(400)
    expect(mocks.dispatchQueuedAnalysisTasks).not.toHaveBeenCalled()
  })

  test('recovers stale tasks globally when the worker omits a project', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ limit: 1 }),
      headers: { 'Content-Type': 'application/json' },
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.recoverStaleAnalysisTasks).toHaveBeenCalledWith(undefined, undefined)
  })
})

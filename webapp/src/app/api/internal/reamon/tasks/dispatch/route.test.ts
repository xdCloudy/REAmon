/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  recoverStaleAnalysisTasks: vi.fn(),
  dispatchQueuedAnalysisTasks: vi.fn(),
  notifyWorkerAlert: vi.fn(),
  recordWorkerDispatch: vi.fn(),
  internal: vi.fn(),
}))

vi.mock('@/lib/session', () => ({ isInternalRequest: mocks.internal }))
vi.mock('@/lib/reamon/task-control', () => ({ recoverStaleAnalysisTasks: mocks.recoverStaleAnalysisTasks }))
vi.mock('@/lib/reamon/task-dispatcher', () => ({ dispatchQueuedAnalysisTasks: mocks.dispatchQueuedAnalysisTasks }))
vi.mock('@/lib/reamon/worker-alerts', () => ({ notifyWorkerAlert: mocks.notifyWorkerAlert }))
vi.mock('@/lib/reamon/worker-health', () => ({ recordWorkerDispatch: mocks.recordWorkerDispatch }))

import { POST } from './route'

const taskResult = { outcome: 'COMPLETED', task: { id: 'task-1', status: 'COMPLETED' } }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.internal.mockReturnValue(true)
  mocks.recoverStaleAnalysisTasks.mockResolvedValue({ recovered: 1, staleAfterMinutes: 30 })
  mocks.dispatchQueuedAnalysisTasks.mockResolvedValue({ requested: 2, selected: 1, workerId: 'worker-a', results: [taskResult] })
  mocks.notifyWorkerAlert.mockResolvedValue({ configured: false, delivered: false, reason: 'healthy' })
  mocks.recordWorkerDispatch.mockResolvedValue({})
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
      body: JSON.stringify({ projectId: 'project-1', limit: 2, staleAfterMinutes: 45, workerId: 'worker-a' }),
      headers: { 'Content-Type': 'application/json' },
    }) as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ recovered: 1, requested: 2, selected: 1, workerId: 'worker-a', results: [taskResult] })
    expect(mocks.recoverStaleAnalysisTasks).toHaveBeenCalledWith('project-1', 45, 'worker-a')
    expect(mocks.dispatchQueuedAnalysisTasks).toHaveBeenCalledWith({ projectId: 'project-1', limit: 2, workerId: 'worker-a' })
    expect(mocks.recordWorkerDispatch).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'worker-a', recovered: 1, selected: 1, completed: 1, failed: 0 }))
    expect(mocks.notifyWorkerAlert).toHaveBeenCalledWith(expect.objectContaining({ workerId: 'worker-a', selected: 1, completed: 1, failed: 0 }))
  })

  test('rejects malformed worker input', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ limit: '2' }),
    }) as never)

    expect(response.status).toBe(400)
    expect(mocks.dispatchQueuedAnalysisTasks).not.toHaveBeenCalled()
  })

  test('rejects an unsafe worker identifier', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ workerId: '../worker' }),
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
    expect(mocks.recoverStaleAnalysisTasks).toHaveBeenCalledWith(undefined, undefined, 'internal-dispatch')
  })
})

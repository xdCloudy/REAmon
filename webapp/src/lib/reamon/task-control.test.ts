/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  taskFindFirst: vi.fn(),
  taskFindMany: vi.fn(),
  taskFindUnique: vi.fn(),
  taskUpdateMany: vi.fn(),
  activityCreate: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    task: { findFirst: mocks.taskFindFirst, findMany: mocks.taskFindMany },
    $transaction: mocks.transaction,
  },
}))

import { cancelAnalysisTask, recoverStaleAnalysisTasks, retryAnalysisTask } from './task-control'

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1', title: 'Inspect source', status: 'FAILED', progress: 10, error: 'provider unavailable',
    runToken: 'run-1', startedAt: new Date('2026-10-02T12:00:00Z'), completedAt: new Date('2026-10-02T12:01:00Z'),
    createdAt: new Date('2026-10-02T11:00:00Z'), updatedAt: new Date('2026-10-02T12:01:00Z'),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.taskFindFirst.mockResolvedValue(task())
  mocks.taskFindUnique.mockResolvedValue(task({ status: 'QUEUED', progress: 0, error: '', runToken: null, startedAt: null, completedAt: null }))
  mocks.taskUpdateMany.mockResolvedValue({ count: 1 })
  mocks.taskFindMany.mockResolvedValue([])
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    task: { updateMany: mocks.taskUpdateMany, findUnique: mocks.taskFindUnique },
    workspaceActivity: { create: mocks.activityCreate },
  }))
})

describe('retryAnalysisTask', () => {
  test('requeues failed work and records an operator activity event', async () => {
    const result = await retryAnalysisTask('project-1', 'task-1')

    expect(result).toMatchObject({ outcome: 'REQUEUED', task: { id: 'task-1', status: 'QUEUED', progress: 0 } })
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-1', projectId: 'project-1', status: { in: ['FAILED', 'CANCELLED'] } },
      data: expect.objectContaining({ status: 'QUEUED', runToken: null }),
    }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'analysis.task.requeued', data: { taskId: 'task-1', reason: 'manual_retry' } }),
    }))
  })

  test('does not retry running work', async () => {
    mocks.taskFindFirst.mockResolvedValue(task({ status: 'RUNNING' }))

    const result = await retryAnalysisTask('project-1', 'task-1')

    expect(result).toMatchObject({ outcome: 'SKIPPED', task: { status: 'RUNNING' } })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})

describe('recoverStaleAnalysisTasks', () => {
  test('requeues old running tasks and records recovery activity', async () => {
    mocks.taskFindMany.mockResolvedValue([
      { id: 'task-1', title: 'Old task', runToken: 'run-1', startedAt: new Date(Date.now() - 60 * 60 * 1000) },
    ])

    const result = await recoverStaleAnalysisTasks('project-1', 30)

    expect(result).toMatchObject({ recovered: 1, staleAfterMinutes: 30 })
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-1', projectId: 'project-1', status: 'RUNNING', runToken: 'run-1' },
      data: expect.objectContaining({ status: 'QUEUED', progress: 0, runToken: null }),
    }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'analysis.task.recovered', data: expect.objectContaining({ taskId: 'task-1' }) }),
    }))
  })

  test('uses the safe default and clamps a too-short recovery window', async () => {
    const result = await recoverStaleAnalysisTasks('project-1', 1)

    expect(result).toMatchObject({ recovered: 0, staleAfterMinutes: 5 })
    expect(mocks.taskFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'RUNNING' }) }))
  })
})

describe('cancelAnalysisTask', () => {
  test('cancels a running lease and records the operator action', async () => {
    mocks.taskFindFirst.mockResolvedValue(task({ status: 'RUNNING', progress: 35, error: '', completedAt: null }))
    mocks.taskFindUnique.mockResolvedValue(task({ status: 'CANCELLED', progress: 35, error: 'Cancelled by operator', completedAt: new Date() }))

    const result = await cancelAnalysisTask('project-1', 'task-1')

    expect(result).toMatchObject({ outcome: 'CANCELLED', task: { status: 'CANCELLED', progress: 35 } })
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-1', projectId: 'project-1', status: { in: ['QUEUED', 'RUNNING'] }, runToken: 'run-1' },
      data: expect.objectContaining({ status: 'CANCELLED', runToken: null }),
    }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'analysis.task.cancelled' }),
    }))
  })
})

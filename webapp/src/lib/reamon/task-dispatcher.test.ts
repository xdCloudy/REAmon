/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  taskFindMany: vi.fn(),
  executeAnalysisTask: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: { task: { findMany: mocks.taskFindMany } } }))
vi.mock('./task-executor', () => ({ executeAnalysisTask: mocks.executeAnalysisTask }))

import { dispatchQueuedAnalysisTasks } from './task-dispatcher'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.taskFindMany.mockResolvedValue([
    { id: 'task-1', projectId: 'project-1' },
    { id: 'task-2', projectId: 'project-1' },
  ])
  mocks.executeAnalysisTask.mockImplementation(async (projectId: string, taskId: string) => ({
    outcome: 'COMPLETED',
    task: { id: taskId, projectId, status: 'COMPLETED' },
  }))
})

describe('dispatchQueuedAnalysisTasks', () => {
  test('selects oldest queued work in a bounded project-scoped batch', async () => {
    const result = await dispatchQueuedAnalysisTasks({ projectId: 'project-1', limit: 20 })

    expect(result).toMatchObject({ requested: 10, selected: 2 })
    expect(mocks.taskFindMany).toHaveBeenCalledWith({
      where: { status: 'QUEUED', projectId: 'project-1' },
      orderBy: { createdAt: 'asc' },
      take: 10,
      select: { id: true, projectId: true },
    })
    expect(mocks.executeAnalysisTask).toHaveBeenNthCalledWith(1, 'project-1', 'task-1', 'internal-dispatch')
    expect(mocks.executeAnalysisTask).toHaveBeenNthCalledWith(2, 'project-1', 'task-2', 'internal-dispatch')
  })

  test('uses a single task by default and tolerates a claim that disappears', async () => {
    mocks.taskFindMany.mockResolvedValue([{ id: 'task-1', projectId: 'project-1' }])
    mocks.executeAnalysisTask.mockResolvedValue(null)

    const result = await dispatchQueuedAnalysisTasks()

    expect(result).toMatchObject({ requested: 1, selected: 1, results: [] })
  })
})

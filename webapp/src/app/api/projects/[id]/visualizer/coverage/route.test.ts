/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  taskFindFirst: vi.fn(),
  getActiveWorkspaceImportSelection: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  reamonObservation: { findMany: mocks.findMany },
  task: { findFirst: mocks.taskFindFirst },
} }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: mocks.getActiveWorkspaceImportSelection }))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

import { GET } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.getActiveWorkspaceImportSelection.mockResolvedValue({ artifactWhere: { projectId: 'project-1', importId: { in: ['active-import'] } } })
  mocks.taskFindFirst.mockResolvedValue({ id: 'run-1' })
  mocks.findMany.mockResolvedValue([])
})

describe('GET /api/projects/[id]/visualizer/coverage', () => {
  test('requires authentication before querying a run', async () => {
    mocks.requireEffectiveUser.mockResolvedValue(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/coverage?taskId=run-1'), params)

    expect(response.status).toBe(401)
    expect(mocks.taskFindFirst).not.toHaveBeenCalled()
  })

  test('counts maintained copies only for code units in the selected active run', async () => {
    mocks.findMany
      .mockResolvedValueOnce([{ id: 'unit-1' }, { id: 'unit-2' }, { id: 'unit-3' }])
      .mockResolvedValueOnce([{ stableKey: 'unit-2' }])

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/coverage?taskId=run-1'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ taskId: 'run-1', codeUnitCount: 3, maintainedUnitCount: 1, coveragePercent: 33 })
    expect(mocks.taskFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'run-1', projectId: 'project-1', status: 'COMPLETED' }),
    }))
    expect(mocks.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ source: 'reamon-maintained-source', type: 'maintained_source', stableKey: { in: ['unit-1', 'unit-2', 'unit-3'] } }),
      select: { stableKey: true },
    }))
  })

  test('rejects runs outside the active workspace', async () => {
    mocks.taskFindFirst.mockResolvedValue(null)

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/coverage?taskId=other-run'), params)

    expect(response.status).toBe(404)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  test('rejects a missing run id', async () => {
    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/coverage'), params)

    expect(response.status).toBe(400)
    expect(mocks.taskFindFirst).not.toHaveBeenCalled()
  })
})

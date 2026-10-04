/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  groupBy: vi.fn(),
  taskFindMany: vi.fn(),
  getActiveWorkspaceImportSelection: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  reamonObservation: { findMany: mocks.findMany, findFirst: mocks.findFirst, count: mocks.count, groupBy: mocks.groupBy },
  task: { findMany: mocks.taskFindMany },
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
  mocks.findMany.mockResolvedValue([])
  mocks.findFirst.mockResolvedValue(null)
  mocks.count.mockResolvedValue(0)
  mocks.groupBy.mockResolvedValue([])
  mocks.taskFindMany.mockResolvedValue([])
})

describe('GET /api/projects/[id]/visualizer', () => {
  test('requires an authenticated user before reading code units', async () => {
    mocks.requireEffectiveUser.mockResolvedValue(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer'), params)

    expect(response.status).toBe(401)
    expect(mocks.findMany).not.toHaveBeenCalled()
    expect(mocks.taskFindMany).not.toHaveBeenCalled()
  })

  test('returns the latest completed run and its normalized units from active artifacts', async () => {
    mocks.taskFindMany.mockResolvedValue([{
      id: 'run-1', title: 'Decompile app.apk',
      createdAt: new Date('2026-10-04T00:00:00.000Z'),
      completedAt: new Date('2026-10-04T00:01:00.000Z'),
      provider: { pluginId: 'reamon-ghidra' },
      result: { decompiledFunctionCount: 2, returnedFunctionCount: 1, codeBytes: 4096, truncated: true, warnings: 'Function cap reached.', failedFunctionCount: 1, visitedFunctionCount: 3 },
      artifact: { originalName: 'app.apk', relativePath: 'app.apk' },
    }])
    mocks.groupBy.mockResolvedValue([{ taskId: 'run-1', _count: { _all: 1 } }])
    mocks.findMany.mockResolvedValue([{
      id: 'observation-1', stableKey: 'function:0x401000', label: 'main', source: 'ghidra', artifactId: 'artifact-1',
      updatedAt: new Date('2026-10-04T00:00:00.000Z'),
      attributes: { unitType: 'function', qualifiedName: 'app.main', address: '0x401000', sizeBytes: 256, coveragePercent: 70, language: 'C' },
      artifact: { relativePath: 'bin/app.exe', originalName: 'app.exe' },
    }])
    mocks.count.mockResolvedValue(1)

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      total: 1,
      hasMore: false,
      selectedRunId: 'run-1',
      runs: [{
        id: 'run-1', artifactName: 'app.apk', codeUnitCount: 1, unitLabel: 'functions',
        discoveredUnitCount: 2, returnedUnitCount: 1, indexedUnitCount: 1, linkPercent: 50,
        codeBytes: 4096, truncated: true, warnings: 'Function cap reached.', failedUnitCount: 1, visitedUnitCount: 3,
      }],
      units: [{ id: 'observation-1', name: 'app.main', address: '0x401000', sizeBytes: 256, coveragePercent: 70, artifactPath: 'bin/app.exe' }],
    })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'project-1', type: 'code_unit', taskId: 'run-1', artifact: { is: { projectId: 'project-1', importId: { in: ['active-import'] } } } },
      take: 1001,
    }))
  })

  test('paginates large code-unit maps with a run-scoped cursor', async () => {
    const row = {
      id: 'observation-1000', stableKey: 'function:1000', label: 'fn1000', source: 'ghidra', artifactId: 'artifact-1',
      updatedAt: new Date('2026-10-04T00:00:00.000Z'),
      attributes: { unitType: 'function', qualifiedName: 'app.fn1000', sizeBytes: 128, language: 'C' },
      artifact: { relativePath: 'bin/app.exe', originalName: 'app.exe' },
    }
    mocks.taskFindMany.mockResolvedValue([{ id: 'run-1', title: 'Run', createdAt: new Date(), completedAt: new Date(), artifact: { originalName: 'app.exe', relativePath: 'app.exe' } }])
    mocks.groupBy.mockResolvedValue([{ taskId: 'run-1', _count: { _all: 2 } }])
    mocks.findFirst.mockResolvedValue({ id: 'observation-999' })
    mocks.findMany.mockResolvedValue([row])
    mocks.count.mockResolvedValue(1001)

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer?taskId=run-1&cursor=observation-999'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ units: [{ id: 'observation-1000' }], total: 1001, hasMore: false, nextCursor: null, selectedRunId: 'run-1' })
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'observation-999', taskId: 'run-1' }) }))
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ cursor: { id: 'observation-999' }, skip: 1, take: 1001 }))
  })

  test('searches the whole selected run before returning a page and count', async () => {
    mocks.taskFindMany.mockResolvedValue([{ id: 'run-1', title: 'Run', createdAt: new Date(), completedAt: new Date(), artifact: { originalName: 'app.apk', relativePath: 'app.apk' } }])
    mocks.groupBy.mockResolvedValue([{ taskId: 'run-1', _count: { _all: 1200 } }])
    mocks.findMany.mockResolvedValue([])
    mocks.count.mockResolvedValue(3)

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer?taskId=run-1&q=com.example.Main'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ total: 3, selectedRunId: 'run-1' })
    const queryWhere = mocks.findMany.mock.calls[0][0].where
    expect(queryWhere).toMatchObject({
      taskId: 'run-1',
      OR: expect.arrayContaining([
        { label: { contains: 'com.example.Main', mode: 'insensitive' } },
        { attributes: { path: ['qualifiedName'], string_contains: 'com.example.Main', mode: 'insensitive' } },
        { artifact: { is: { OR: [
          { relativePath: { contains: 'com.example.Main', mode: 'insensitive' } },
          { originalName: { contains: 'com.example.Main', mode: 'insensitive' } },
        ] } } },
      ]),
    })
    expect(mocks.count).toHaveBeenCalledWith({ where: queryWhere })
  })

  test('rejects an overlong code-unit search term', async () => {
    const response = await GET(new Request(`http://localhost/api/projects/project-1/visualizer?q=${'a'.repeat(301)}`), params)

    expect(response.status).toBe(400)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  test('rejects cursors outside the selected run before reading another page', async () => {
    mocks.taskFindMany.mockResolvedValue([{ id: 'run-1', title: 'Run', createdAt: new Date(), completedAt: new Date(), artifact: { originalName: 'app.exe', relativePath: 'app.exe' } }])
    mocks.groupBy.mockResolvedValue([{ taskId: 'run-1', _count: { _all: 1 } }])
    mocks.findFirst.mockResolvedValue(null)

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer?taskId=run-1&cursor=other-run-row'), params)

    expect(response.status).toBe(400)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  test('selects a requested older run and rejects IDs outside the active workspace history', async () => {
    mocks.taskFindMany.mockResolvedValue([
      { id: 'run-new', title: 'New', createdAt: new Date(), completedAt: new Date(), artifact: { originalName: 'app.apk', relativePath: 'app.apk' } },
      { id: 'run-old', title: 'Old', createdAt: new Date(), completedAt: new Date(), artifact: { originalName: 'app.apk', relativePath: 'app.apk' } },
    ])
    mocks.groupBy.mockResolvedValue([
      { taskId: 'run-new', _count: { _all: 2 } },
      { taskId: 'run-old', _count: { _all: 1 } },
    ])

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer?taskId=run-old'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ selectedRunId: 'run-old', total: 0 })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ taskId: 'run-old' }) }))

    mocks.findMany.mockClear()
    const missing = await GET(new Request('http://localhost/api/projects/project-1/visualizer?taskId=other-project-run'), params)

    expect(missing.status).toBe(404)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })
})

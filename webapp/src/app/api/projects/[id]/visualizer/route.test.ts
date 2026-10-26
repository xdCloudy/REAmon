/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  groupBy: vi.fn(),
  taskFindMany: vi.fn(),
  taskFindFirst: vi.fn(),
  maintainedSourceFindMany: vi.fn(),
  codeReviewFindMany: vi.fn(),
  codeDraftFindMany: vi.fn(),
  getActiveWorkspaceImportSelection: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  reamonObservation: { findMany: mocks.findMany, findFirst: mocks.findFirst, count: mocks.count, groupBy: mocks.groupBy },
  reamonMaintainedSource: { findMany: mocks.maintainedSourceFindMany },
  reamonCodeReview: { findMany: mocks.codeReviewFindMany },
  reamonCodeDraft: { findMany: mocks.codeDraftFindMany },
  task: { findMany: mocks.taskFindMany, findFirst: mocks.taskFindFirst },
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
  mocks.taskFindFirst.mockResolvedValue(null)
  mocks.maintainedSourceFindMany.mockResolvedValue([])
  mocks.codeReviewFindMany.mockResolvedValue([])
  mocks.codeDraftFindMany.mockResolvedValue([])
})

describe('GET /api/projects/[id]/visualizer', () => {
  test('requires an authenticated user before reading code units', async () => {
    mocks.requireEffectiveUser.mockResolvedValue(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer'), params)

    expect(response.status).toBe(401)
    expect(mocks.findMany).not.toHaveBeenCalled()
    expect(mocks.taskFindMany).not.toHaveBeenCalled()
  })

  test('keeps failed-run output safe when optional task messages are null', async () => {
    mocks.taskFindMany
      .mockResolvedValueOnce([{
        id: 'failed-run', title: 'Failed run', status: 'FAILED', progressMessage: null, error: null,
        createdAt: new Date('2026-10-04T00:00:00.000Z'), completedAt: null,
        artifact: { originalName: 'app.exe', relativePath: 'app.exe' },
      }])
      .mockResolvedValueOnce([])

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      failedRuns: [{ id: 'failed-run', progressMessage: '', error: '' }],
    })
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
    mocks.groupBy.mockResolvedValue([{ taskId: 'run-1', type: 'code_unit', _count: { _all: 1 } }])
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

  test('returns bounded DEX failure identities from saved run diagnostics', async () => {
    const failedClassDetails = Array.from({ length: 101 }, (_, classIndex) => ({
      dexEntry: 'classes2.dex', classIndex, descriptor: `Lcom/example/Failed${classIndex};`, reason: 'class reconstruction failed',
    }))
    mocks.taskFindMany.mockResolvedValue([{
      id: 'run-dex', title: 'Decompile app.apk', createdAt: new Date('2026-10-04T00:00:00.000Z'),
      completedAt: new Date('2026-10-04T00:01:00.000Z'), provider: { pluginId: 'reamon-dex-decompiler' },
      result: { discoveredClassCount: 102, returnedClassCount: 1, failedClassDetails: [...failedClassDetails, { dexEntry: 'invalid', classIndex: -1, reason: 'bad record' }] },
      artifact: { originalName: 'app.apk', relativePath: 'app.apk' },
    }])
    mocks.groupBy.mockResolvedValue([{ taskId: 'run-dex', type: 'code_unit', _count: { _all: 1 } }])
    mocks.findMany.mockResolvedValue([])
    mocks.count.mockResolvedValue(1)

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer'), params)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.runs[0].failedClassDetails).toHaveLength(100)
    expect(body.runs[0].failedClassDetails[0]).toEqual(failedClassDetails[0])
    expect(body.runs[0].failedClassDetailsTruncated).toBe(true)
    expect(body.runs[0].failedClassDetails.some((detail: { classIndex: number }) => detail.classIndex === -1)).toBe(false)
  })

  test('paginates large code-unit maps with a run-scoped cursor', async () => {
    const row = {
      id: 'observation-1000', stableKey: 'function:1000', label: 'fn1000', source: 'ghidra', artifactId: 'artifact-1',
      updatedAt: new Date('2026-10-04T00:00:00.000Z'),
      attributes: { unitType: 'function', qualifiedName: 'app.fn1000', sizeBytes: 128, language: 'C' },
      artifact: { relativePath: 'bin/app.exe', originalName: 'app.exe' },
    }
    mocks.taskFindMany.mockResolvedValue([{ id: 'run-1', title: 'Run', createdAt: new Date(), completedAt: new Date(), artifact: { originalName: 'app.exe', relativePath: 'app.exe' } }])
    mocks.groupBy.mockResolvedValue([{ taskId: 'run-1', type: 'code_unit', _count: { _all: 2 } }])
    mocks.findFirst.mockResolvedValue({ id: 'observation-999' })
    mocks.findMany.mockResolvedValue([row])
    mocks.count.mockResolvedValue(1001)

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer?taskId=run-1&cursor=observation-999'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ units: [{ id: 'observation-1000' }], total: 1001, hasMore: false, nextCursor: null, selectedRunId: 'run-1' })
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'observation-999', taskId: 'run-1' }) }))
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ cursor: { id: 'observation-999' }, skip: 1, take: 1001 }))
  })

  test('loads one code unit by id for shareable links outside the first page', async () => {
    const row = {
      id: 'observation-deep', stableKey: 'class:deep', label: 'DeepClass', source: 'jadx', artifactId: 'artifact-1',
      updatedAt: new Date('2026-10-04T00:00:00.000Z'),
      attributes: { unitType: 'class', qualifiedName: 'app.DeepClass', sizeBytes: 128, language: 'Java' },
      artifact: { relativePath: 'app.apk', originalName: 'app.apk' },
    }
    mocks.taskFindMany.mockResolvedValue([{ id: 'run-1', title: 'Run', createdAt: new Date(), completedAt: new Date(), artifact: { originalName: 'app.apk', relativePath: 'app.apk' } }])
    mocks.groupBy.mockResolvedValue([{ taskId: 'run-1', type: 'code_unit', _count: { _all: 1200 } }])
    mocks.findMany.mockResolvedValueOnce([row])
    mocks.count.mockResolvedValue(1)

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer?taskId=run-1&unitId=observation-deep'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ units: [{ id: 'observation-deep', name: 'app.DeepClass' }], total: 1, selectedRunId: 'run-1' })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'observation-deep', taskId: 'run-1' }),
      take: 1001,
    }))
  })

  test('marks saved maintained copies on their code units and reports workspace coverage', async () => {
    const baseSourceHash = 'a'.repeat(64)
    const maintainedSourceCode = 'class Main { void execute() {} }'
    const maintainedSourceHash = createHash('sha256').update(maintainedSourceCode).digest('hex')
    mocks.taskFindMany.mockResolvedValue([{ id: 'run-1', title: 'Run', createdAt: new Date(), completedAt: new Date(), artifact: { originalName: 'app.apk', relativePath: 'app.apk' } }])
    mocks.groupBy.mockResolvedValue([{ taskId: 'run-1', type: 'code_unit', _count: { _all: 1 } }])
    mocks.findMany
      .mockResolvedValueOnce([{
        id: 'observation-1', stableKey: 'class:app.Main', label: 'Main', source: 'jadx', artifactId: 'artifact-1',
        updatedAt: new Date('2026-10-04T00:00:00.000Z'),
        attributes: { unitType: 'class', qualifiedName: 'app.Main', sizeBytes: 100, language: 'Java', codeArtifactSha256: baseSourceHash },
        artifact: { relativePath: 'app.apk', originalName: 'app.apk' },
      }])
      .mockResolvedValueOnce([{ stableKey: 'observation-1' }])
    mocks.maintainedSourceFindMany.mockResolvedValueOnce([{
      codeUnitId: 'observation-1', artifactId: 'artifact-1', sourceCode: maintainedSourceCode,
      sourceHash: maintainedSourceHash, acceptedReviewId: 'review-1',
      symbolIndex: { sourceLineage: { baseSourceHash } },
    }])
    mocks.codeReviewFindMany.mockResolvedValueOnce([{
      id: 'review-1', codeUnitId: 'observation-1', artifactId: 'artifact-1', maintainedSourceHash,
    }])
    mocks.count.mockResolvedValueOnce(1).mockResolvedValueOnce(1)

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      maintainedCount: 1,
      units: [{ id: 'observation-1', maintainedSource: true }],
    })
    expect(mocks.maintainedSourceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'project-1', artifactId: { in: ['artifact-1'] }, codeUnitId: { in: ['observation-1'] } },
      select: { codeUnitId: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true },
    }))
    expect(mocks.codeReviewFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'project-1', id: { in: ['review-1'] }, decision: 'ACCEPTED' },
    }))
  })

  test('searches the whole selected run before returning a page and count', async () => {
    mocks.taskFindMany.mockResolvedValue([{ id: 'run-1', title: 'Run', createdAt: new Date(), completedAt: new Date(), artifact: { originalName: 'app.apk', relativePath: 'app.apk' } }])
    mocks.groupBy.mockResolvedValue([{ taskId: 'run-1', type: 'code_unit', _count: { _all: 1200 } }])
    mocks.findMany.mockResolvedValue([])
    mocks.count.mockResolvedValue(3)

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer?taskId=run-1&q=com.example.Main'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ total: 3, selectedRunId: 'run-1' })
    const codeUnitQuery = mocks.findMany.mock.calls
      .map(([query]) => query)
      .find((query) => query.where?.taskId === 'run-1' && query.where?.type === 'code_unit' && Array.isArray(query.where.OR))
    expect(codeUnitQuery).toBeDefined()
    const queryWhere = codeUnitQuery!.where
    expect(queryWhere).toMatchObject({
      taskId: 'run-1',
      OR: expect.arrayContaining([
        { label: { contains: 'com.example.Main', mode: 'insensitive' } },
        { stableKey: { contains: 'com.example.Main', mode: 'insensitive' } },
        { attributes: { path: ['name'], string_contains: 'com.example.Main', mode: 'insensitive' } },
        { attributes: { path: ['qualifiedName'], string_contains: 'com.example.Main', mode: 'insensitive' } },
        { attributes: { path: ['address'], string_contains: 'com.example.Main', mode: 'insensitive' } },
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
    mocks.groupBy.mockResolvedValue([{ taskId: 'run-1', type: 'code_unit', _count: { _all: 1 } }])
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
      { taskId: 'run-new', type: 'code_unit', _count: { _all: 2 } },
      { taskId: 'run-old', type: 'code_unit', _count: { _all: 1 } },
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

  test('reports discovered, returned, and database-indexed DEX methods separately', async () => {
    mocks.taskFindMany.mockResolvedValue([{
      id: 'run-dex', title: 'Decompile app.apk', createdAt: new Date(), completedAt: new Date(),
      provider: { pluginId: 'reamon-dex-decompiler' },
      result: { discoveredClassCount: 1, returnedClassCount: 1, discoveredMethodCount: 12_400, returnedMethodCount: 10_000, methodsTruncated: true },
      artifact: { originalName: 'app.apk', relativePath: 'app.apk' },
    }])
    mocks.groupBy.mockResolvedValue([
      { taskId: 'run-dex', type: 'code_unit', _count: { _all: 1 } },
      { taskId: 'run-dex', type: 'function', _count: { _all: 9_950 } },
    ])
    mocks.findMany.mockResolvedValue([])

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      runs: [{ discoveredMethodCount: 12_400, returnedMethodCount: 10_000, indexedMethodCount: 9_950, methodsTruncated: true }],
    })
    expect(mocks.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ['taskId', 'type'],
      where: expect.objectContaining({ type: { in: ['code_unit', 'function'] } }),
    }))
  })
})

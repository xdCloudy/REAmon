/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  maintainedSourceFindMany: vi.fn(),
  codeReviewFindMany: vi.fn(),
  codeDraftFindMany: vi.fn(),
  taskFindFirst: vi.fn(),
  getActiveWorkspaceImportSelection: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  reamonObservation: { findMany: mocks.findMany },
  reamonMaintainedSource: { findMany: mocks.maintainedSourceFindMany },
  reamonCodeReview: { findMany: mocks.codeReviewFindMany },
  reamonCodeDraft: { findMany: mocks.codeDraftFindMany },
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
  mocks.maintainedSourceFindMany.mockResolvedValue([])
  mocks.codeReviewFindMany.mockResolvedValue([])
  mocks.codeDraftFindMany.mockResolvedValue([])
})

describe('GET /api/projects/[id]/visualizer/coverage', () => {
  test('requires authentication before querying a run', async () => {
    mocks.requireEffectiveUser.mockResolvedValue(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/coverage?taskId=run-1'), params)

    expect(response.status).toBe(401)
    expect(mocks.taskFindFirst).not.toHaveBeenCalled()
  })

  test('counts maintained copies only for code units in the selected active run', async () => {
    const baseSourceHash = 'a'.repeat(64)
    const maintainedSourceCode = 'class Helper { void run() {} }'
    const maintainedSourceHash = createHash('sha256').update(maintainedSourceCode).digest('hex')
    mocks.findMany
      .mockResolvedValueOnce([
        { id: 'unit-1', stableKey: 'class:main', label: 'Main', source: 'jadx', artifactId: 'artifact-1', updatedAt: new Date(), attributes: { sizeBytes: 100, decompiled: true, codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/Main.java' } },
        { id: 'unit-2', stableKey: 'class:helper', label: 'Helper', source: 'jadx', artifactId: 'artifact-1', updatedAt: new Date(), attributes: { sizeBytes: 300, coveragePercent: 50, codeArtifactSha256: baseSourceHash, codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/Helper.java' } },
        { id: 'unit-3', stableKey: 'class:unknown', label: 'Unknown', source: 'jadx', artifactId: 'artifact-1', updatedAt: new Date(), attributes: { sizeBytes: 100 } },
      ])
    mocks.maintainedSourceFindMany.mockResolvedValueOnce([{
      codeUnitId: 'unit-2', artifactId: 'artifact-1', sourceCode: maintainedSourceCode,
      sourceHash: maintainedSourceHash, acceptedReviewId: 'review-2',
      symbolIndex: { sourceLineage: { baseSourceHash } },
    }])
    mocks.codeReviewFindMany.mockResolvedValueOnce([{
      id: 'review-2', codeUnitId: 'unit-2', artifactId: 'artifact-1', maintainedSourceHash,
    }])

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/coverage?taskId=run-1'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      taskId: 'run-1', codeUnitCount: 3, maintainedUnitCount: 1, reviewedUnitCount: 1,
      validatedUnitCount: 0, unmatchedLegacyValidationUnitCount: 0,
      coveragePercent: 33, reviewedPercent: 33, validatedPercent: 0,
      decompilationCoveragePercent: 63, sourceLinkedPercent: 67, codeBytes: 500, measuredBytes: 400,
    })
    expect(mocks.taskFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'run-1', projectId: 'project-1', status: 'COMPLETED' }),
    }))
    expect(mocks.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      select: { id: true, stableKey: true, label: true, source: true, artifactId: true, updatedAt: true, attributes: true },
    }))
    expect(mocks.maintainedSourceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'project-1', codeUnitId: { in: ['unit-1', 'unit-2', 'unit-3'] }, artifactId: { in: ['artifact-1'] } },
      select: { codeUnitId: true, artifactId: true, sourceCode: true, sourceHash: true, acceptedReviewId: true, symbolIndex: true },
    }))
    expect(mocks.codeReviewFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'project-1', id: { in: ['review-2'] }, decision: 'ACCEPTED' },
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

/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  buildWorkspaceAnalysisPlan: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccessStrict: vi.fn(),
  activityFindFirst: vi.fn(),
  activityFindMany: vi.fn(),
}))

vi.mock('@/lib/reamon/inventory-query', () => ({ listWorkspaceFiles: mocks.listWorkspaceFiles }))
vi.mock('@/lib/reamon/analysis-plan', () => ({
  buildWorkspaceAnalysisPlan: mocks.buildWorkspaceAnalysisPlan,
  MAX_ANALYSIS_PLAN_STEP_PAGE_SIZE: 500,
}))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccessStrict: mocks.requireProjectAccessStrict,
}))
vi.mock('@/lib/prisma', () => ({
  default: {
    workspaceActivity: {
      findFirst: mocks.activityFindFirst,
      findMany: mocks.activityFindMany,
    },
    task: { findMany: vi.fn() },
  },
}))

import { GET } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccessStrict.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.activityFindFirst.mockResolvedValue(null)
  mocks.activityFindMany.mockResolvedValue([])
  mocks.listWorkspaceFiles.mockResolvedValue({ artifacts: [], total: 0, limit: 25, offset: 50, hasMore: false })
  mocks.buildWorkspaceAnalysisPlan.mockReturnValue({
    projectId: 'project-1', source: 'ACTIVE_WORKSPACE_INVENTORY', requestedCapability: 'disassemble',
    query: { capability: 'disassemble', kind: 'executables', limit: 25, offset: 50 },
    candidateArtifacts: 0, returnedArtifacts: 0, proposedSteps: 0, totalCandidateSteps: 0,
    stepLimit: 75, stepOffset: 500, snapshotId: 'a'.repeat(64), nextStepOffset: null,
    steps: [], hasMoreArtifacts: false, hasMoreSteps: false,
  })
})

describe('GET /api/projects/[id]/workspace/analysis-plan', () => {
  test('authenticates and forwards bounded planning filters', async () => {
    const response = await GET(new Request(`http://localhost/api/projects/project-1/workspace/analysis-plan?kind=executables&capability=disassemble&limit=25&offset=50&stepLimit=75&stepOffset=500&snapshotId=${'a'.repeat(64)}`), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ projectId: 'project-1', proposedSteps: 0 })
    expect(mocks.requireProjectAccessStrict).toHaveBeenCalledWith({ userId: 'user-1' }, 'project-1')
    expect(mocks.listWorkspaceFiles).toHaveBeenCalledWith('project-1', {
      search: undefined, format: undefined, kind: 'executables', limit: 25, offset: 50,
    })
    expect(mocks.buildWorkspaceAnalysisPlan).toHaveBeenCalledWith('project-1', expect.any(Object), {
      search: undefined, format: undefined, kind: 'executables', capability: 'disassemble', limit: 25, offset: 50, stepLimit: 75, stepOffset: 500, snapshotId: 'a'.repeat(64),
    })
    expect(mocks.activityFindFirst).toHaveBeenCalledWith({
      where: { projectId: 'project-1', eventType: 'analysis.project.scanned' },
      orderBy: { createdAt: 'desc' },
      select: { data: true, createdAt: true },
    })
    expect(mocks.activityFindMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1', eventType: 'analysis.proposal.cleared' },
      select: { data: true },
    })
  })

  test('rejects invalid bounds before querying inventory', async () => {
    for (const query of ['?limit=0', '?limit=101', '?offset=-1', '?offset=100001', '?stepLimit=0', '?stepLimit=501', '?stepOffset=-1', '?stepOffset=100001', '?stepOffset=1', '?snapshotId=short', '?kind=domains']) {
      const response = await GET(new Request(`http://localhost/api/projects/project-1/workspace/analysis-plan${query}`), params)
      expect(response.status, query).toBe(400)
    }
    expect(mocks.listWorkspaceFiles).not.toHaveBeenCalled()
  })

  test('rejects a stale proposal snapshot before activity enrichment', async () => {
    const response = await GET(new Request(`http://localhost/api/projects/project-1/workspace/analysis-plan?stepOffset=500&snapshotId=${'b'.repeat(64)}`), params)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'SNAPSHOT_STALE' }, snapshotId: 'a'.repeat(64), restartStepOffset: 0,
    })
    expect(mocks.activityFindFirst).not.toHaveBeenCalled()
  })

  test('rejects overlong planner filters', async () => {
    const response = await GET(new Request(`http://localhost/api/projects/project-1/workspace/analysis-plan?capability=${'x'.repeat(65)}`), params)

    expect(response.status).toBe(400)
    expect(mocks.listWorkspaceFiles).not.toHaveBeenCalled()
  })

  test('rejects foreign project access before reading inventory or proposal history', async () => {
    mocks.requireProjectAccessStrict.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))

    const response = await GET(new Request('http://localhost/api/projects/project-1/workspace/analysis-plan'), params)

    expect(response.status).toBe(404)
    expect(mocks.listWorkspaceFiles).not.toHaveBeenCalled()
    expect(mocks.activityFindFirst).not.toHaveBeenCalled()
    expect(mocks.activityFindMany).not.toHaveBeenCalled()
  })
})


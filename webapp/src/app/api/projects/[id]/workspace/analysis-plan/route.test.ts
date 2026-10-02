/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  buildWorkspaceAnalysisPlan: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/reamon/inventory-query', () => ({ listWorkspaceFiles: mocks.listWorkspaceFiles }))
vi.mock('@/lib/reamon/analysis-plan', () => ({ buildWorkspaceAnalysisPlan: mocks.buildWorkspaceAnalysisPlan }))
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
  mocks.listWorkspaceFiles.mockResolvedValue({ artifacts: [], total: 0, limit: 25, offset: 50, hasMore: false })
  mocks.buildWorkspaceAnalysisPlan.mockReturnValue({
    projectId: 'project-1', source: 'ACTIVE_WORKSPACE_INVENTORY', requestedCapability: 'disassemble',
    query: { capability: 'disassemble', kind: 'executables', limit: 25, offset: 50 },
    candidateArtifacts: 0, returnedArtifacts: 0, proposedSteps: 0, steps: [], hasMoreArtifacts: false, hasMoreSteps: false,
  })
})

describe('GET /api/projects/[id]/workspace/analysis-plan', () => {
  test('authenticates and forwards bounded planning filters', async () => {
    const response = await GET(new Request('http://localhost/api/projects/project-1/workspace/analysis-plan?kind=executables&capability=disassemble&limit=25&offset=50'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ projectId: 'project-1', proposedSteps: 0 })
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith({ userId: 'user-1' }, 'project-1')
    expect(mocks.listWorkspaceFiles).toHaveBeenCalledWith('project-1', {
      search: undefined, format: undefined, kind: 'executables', limit: 25, offset: 50,
    })
    expect(mocks.buildWorkspaceAnalysisPlan).toHaveBeenCalledWith('project-1', expect.any(Object), {
      search: undefined, format: undefined, kind: 'executables', capability: 'disassemble', limit: 25, offset: 50,
    })
  })

  test('rejects invalid bounds before querying inventory', async () => {
    for (const query of ['?limit=0', '?limit=101', '?offset=-1', '?offset=100001', '?kind=domains']) {
      const response = await GET(new Request(`http://localhost/api/projects/project-1/workspace/analysis-plan${query}`), params)
      expect(response.status, query).toBe(400)
    }
    expect(mocks.listWorkspaceFiles).not.toHaveBeenCalled()
  })

  test('rejects overlong planner filters', async () => {
    const response = await GET(new Request(`http://localhost/api/projects/project-1/workspace/analysis-plan?capability=${'x'.repeat(65)}`), params)

    expect(response.status).toBe(400)
    expect(mocks.listWorkspaceFiles).not.toHaveBeenCalled()
  })
})


/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  listWorkspaceFiles: vi.fn(),
  taskCount: vi.fn(),
  findingCount: vi.fn(),
  hypothesisCount: vi.fn(),
  evidenceCount: vi.fn(),
  activityCreate: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))
vi.mock('@/lib/reamon/inventory-query', () => ({ listWorkspaceFiles: mocks.listWorkspaceFiles }))
vi.mock('@/lib/prisma', () => ({
  default: {
    task: { count: mocks.taskCount },
    finding: { count: mocks.findingCount },
    hypothesis: { count: mocks.hypothesisCount },
    evidence: { count: mocks.evidenceCount },
    workspaceActivity: { create: mocks.activityCreate },
  },
}))

import { POST } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  const capabilities = Array.from({ length: 1205 }, (_, index) => `capability-${index}`)
  mocks.listWorkspaceFiles.mockResolvedValue({
    artifacts: [{ id: 'artifact-1', capabilities: [{ capabilities }] }],
    total: 1,
    limit: 500,
    offset: 0,
    hasMore: false,
  })
  mocks.taskCount.mockResolvedValue(3)
  mocks.findingCount.mockResolvedValue(2)
  mocks.hypothesisCount.mockResolvedValue(1)
  mocks.evidenceCount.mockResolvedValue(5)
  mocks.activityCreate.mockResolvedValue({ createdAt: new Date('2026-11-09T00:00:00.000Z') })
})

describe('POST /api/projects/[id]/workspace/analysis-plan/scan', () => {
  test('reports the complete proposal count beyond one response-page limit', async () => {
    const response = await POST(new Request('http://localhost/api/projects/project-1/workspace/analysis-plan/scan', { method: 'POST' }), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      artifactsScanned: 1,
      proposalCount: 1205,
      previousTasks: 3,
      findings: 2,
      hypotheses: 1,
      evidence: 5,
    })
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ data: expect.objectContaining({ proposalCount: 1205 }) }),
    }))
  })
})

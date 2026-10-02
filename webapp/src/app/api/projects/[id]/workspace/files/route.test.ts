/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/reamon/inventory-query', () => ({ listWorkspaceFiles: mocks.listWorkspaceFiles }))
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
  mocks.listWorkspaceFiles.mockResolvedValue({ artifacts: [], total: 0, limit: 25, hasMore: false })
})

describe('GET /api/projects/[id]/workspace/files', () => {
  test('passes bounded logical inventory filters through the authenticated route', async () => {
    const response = await GET(new Request('http://localhost/api/projects/project-1/workspace/files?search=crypto&format=pe&kind=executables&limit=25'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ artifacts: [], total: 0, limit: 25, hasMore: false })
    expect(mocks.listWorkspaceFiles).toHaveBeenCalledWith('project-1', {
      search: 'crypto',
      format: 'pe',
      kind: 'executables',
      limit: 25,
    })
  })

  test('rejects unsupported filters before querying inventory', async () => {
    const response = await GET(new Request('http://localhost/api/projects/project-1/workspace/files?kind=domains'), params)

    expect(response.status).toBe(400)
    expect(mocks.listWorkspaceFiles).not.toHaveBeenCalled()
  })

  test('rejects non-positive and non-integer limits', async () => {
    for (const limit of ['0', '1.5', 'NaN']) {
      const response = await GET(new Request(`http://localhost/api/projects/project-1/workspace/files?limit=${limit}`), params)
      expect(response.status).toBe(400)
    }
    expect(mocks.listWorkspaceFiles).not.toHaveBeenCalled()
  })
})

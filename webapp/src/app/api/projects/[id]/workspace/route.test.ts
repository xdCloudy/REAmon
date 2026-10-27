/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getWorkspaceSnapshot: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/reamon/workspace', () => ({ getWorkspaceSnapshot: mocks.getWorkspaceSnapshot }))
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
  mocks.getWorkspaceSnapshot.mockResolvedValue({
    workspace: { id: 'project-1', name: 'QA workspace' },
    workers: [{ workerId: 'other-project-worker', lastError: 'private task error from another project' }],
  })
})

describe('GET /api/projects/[id]/workspace', () => {
  test('does not serialize global worker telemetry into a project workspace', async () => {
    const response = await GET(new Request('http://localhost/api/projects/project-1/workspace'), params)

    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('QA workspace')
    expect(body).not.toContain('workers')
    expect(body).not.toContain('other-project-worker')
    expect(body).not.toContain('private task error from another project')
  })

  test('checks project access before reading its workspace snapshot', async () => {
    await GET(new Request('http://localhost/api/projects/project-1/workspace'), params)

    expect(mocks.requireProjectAccess).toHaveBeenCalledWith({ userId: 'user-1' }, 'project-1')
    expect(mocks.getWorkspaceSnapshot).toHaveBeenCalledWith('project-1')
  })
})

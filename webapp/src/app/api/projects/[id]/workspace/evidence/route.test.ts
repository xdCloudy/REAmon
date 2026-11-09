/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/reamon/workspace-evidence', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reamon/workspace-evidence')>('@/lib/reamon/workspace-evidence')
  return { ...actual, listPersistedWorkspaceEvidence: (...args: unknown[]) => mocks.list(...args) }
})
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
  mocks.list.mockResolvedValue({ projectId: 'project-1', evidence: [], total: 0, limit: 25, hasMore: false, nextCursor: null })
})

describe('GET /api/projects/[id]/workspace/evidence', () => {
  test('returns the shared project evidence page after checking ownership', async () => {
    const response = await GET(new Request('http://localhost/api/projects/project-1/workspace/evidence?artifactId=artifact-1&limit=12&cursor=opaque'), params)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.requireProjectAccess).toHaveBeenCalledWith({ userId: 'user-1' }, 'project-1')
    expect(mocks.list).toHaveBeenCalledWith({ projectId: 'project-1', artifactId: 'artifact-1', limit: 12, cursor: 'opaque' })
  })

  test('rejects invalid bounds before reading evidence', async () => {
    for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'artifactId=%0A', `cursor=${'x'.repeat(513)}`]) {
      const response = await GET(new Request(`http://localhost/api/projects/project-1/workspace/evidence?${query}`), params)
      expect(response.status).toBe(400)
    }
    expect(mocks.list).not.toHaveBeenCalled()
  })

  test('does not query evidence for a project the user cannot access', async () => {
    const { NextResponse } = await import('next/server')
    mocks.requireProjectAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))

    const response = await GET(new Request('http://localhost/api/projects/other/workspace/evidence'), params)
    expect(response.status).toBe(404)
    expect(mocks.list).not.toHaveBeenCalled()
  })
})

/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccessStrict: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccessStrict: mocks.requireProjectAccessStrict,
}))
vi.mock('@/lib/mcp/workspaceCodeTools', () => ({ listWorkspaceCodeUnits: (...args: unknown[]) => mocks.list(...args) }))

import { GET } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccessStrict.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.list.mockResolvedValue({ units: [], total: 0, limit: 25, hasMore: false, nextCursor: null })
})

describe('GET /api/projects/[id]/workspace/code-units', () => {
  test('requires strict project ownership and delegates bounded cursor paging', async () => {
    const response = await GET(new Request('http://localhost/api/projects/project-1/workspace/code-units?taskId=task-1&limit=12&cursor=opaque&search=main'), params)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.requireProjectAccessStrict).toHaveBeenCalledWith({ userId: 'user-1' }, 'project-1')
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ token: expect.objectContaining({ userId: 'user-1', scopes: ['recon:read'] }) }),
      { projectId: 'project-1', search: 'main', taskId: 'task-1', limit: 12, cursor: 'opaque' },
    )
    expect(mocks.list.mock.calls[0][1]).not.toHaveProperty('offset')
  })

  test('rejects invalid paging bounds before reading code units', async () => {
    for (const query of ['limit=101', 'offset=-1', 'limit=1.5', 'cursor=opaque&offset=1', `cursor=${'x'.repeat(2049)}`]) {
      const response = await GET(new Request(`http://localhost/api/projects/project-1/workspace/code-units?${query}`), params)
      expect(response.status).toBe(400)
    }
    expect(mocks.list).not.toHaveBeenCalled()
  })

  test('does not query code units when strict project ownership fails', async () => {
    const { NextResponse } = await import('next/server')
    mocks.requireProjectAccessStrict.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
    const response = await GET(new Request('http://localhost/api/projects/other/workspace/code-units'), params)
    expect(response.status).toBe(404)
    expect(mocks.list).not.toHaveBeenCalled()
  })
})

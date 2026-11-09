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
vi.mock('@/lib/mcp/workspaceCodeTools', () => ({ listWorkspaceCodeRelationships: (...args: unknown[]) => mocks.list(...args) }))

import { GET } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccessStrict.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.list.mockResolvedValue({ relationships: [], total: 0, limit: 25, hasMore: false, nextCursor: null })
})

describe('GET /api/projects/[id]/workspace/code-relationships', () => {
  test('requires strict ownership and delegates the exact relationship page scope', async () => {
    const response = await GET(new Request('http://localhost/api/projects/project-1/workspace/code-relationships?codeUnitId=unit-1&relationshipKind=calls&direction=outgoing&limit=12&cursor=opaque'), params)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.requireProjectAccessStrict).toHaveBeenCalledWith({ userId: 'user-1' }, 'project-1')
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ token: expect.objectContaining({ userId: 'user-1', scopes: ['recon:read'] }) }),
      { projectId: 'project-1', codeUnitId: 'unit-1', relationshipKind: 'calls', direction: 'outgoing', limit: 12, cursor: 'opaque' },
    )
  })

  test('rejects invalid relationship scope and paging bounds before reading', async () => {
    for (const query of [
      'codeUnitId=unit-1&relationshipKind=unknown',
      'codeUnitId=unit-1&relationshipKind=calls&direction=sideways',
      'codeUnitId=unit-1&relationshipKind=references&limit=101',
      'codeUnitId=unit-1&relationshipKind=calls&cursor=opaque&offset=1',
    ]) {
      const response = await GET(new Request(`http://localhost/api/projects/project-1/workspace/code-relationships?${query}`), params)
      expect(response.status).toBe(400)
    }
    expect(mocks.list).not.toHaveBeenCalled()
  })

  test('does not query relationships when strict project ownership fails', async () => {
    const { NextResponse } = await import('next/server')
    mocks.requireProjectAccessStrict.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
    const response = await GET(new Request('http://localhost/api/projects/other/workspace/code-relationships?codeUnitId=unit-1&relationshipKind=calls'), params)
    expect(response.status).toBe(404)
    expect(mocks.list).not.toHaveBeenCalled()
  })
})

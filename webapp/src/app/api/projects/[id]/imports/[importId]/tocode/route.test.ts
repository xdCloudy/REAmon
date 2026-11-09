/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccessStrict: vi.fn(),
  indexToCodeWorkspaceImport: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccessStrict: mocks.requireProjectAccessStrict,
}))
vi.mock('@/lib/reamon/tocode-import', () => ({
  indexToCodeWorkspaceImport: mocks.indexToCodeWorkspaceImport,
}))

import { POST } from './route'

function params() {
  return { params: Promise.resolve({ id: 'project-1', importId: 'import-1' }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccessStrict.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.indexToCodeWorkspaceImport.mockResolvedValue({ taskId: 'task-1', indexedFunctions: 3, alreadyIndexed: false })
})

describe('POST /api/projects/[id]/imports/[importId]/tocode', () => {
  test('denies foreign project access before starting ToCode indexing', async () => {
    const { NextResponse } = await import('next/server')
    mocks.requireProjectAccessStrict.mockResolvedValueOnce(NextResponse.json({ error: 'Not found' }, { status: 404 }))

    const response = await POST(new Request('http://localhost', { method: 'POST' }), params())

    expect(response.status).toBe(404)
    expect(mocks.indexToCodeWorkspaceImport).not.toHaveBeenCalled()
  })

  test('runs indexing for an authorized project and returns its receipt', async () => {
    const response = await POST(new Request('http://localhost', { method: 'POST' }), params())

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ taskId: 'task-1', indexedFunctions: 3, alreadyIndexed: false })
    expect(mocks.indexToCodeWorkspaceImport).toHaveBeenCalledWith('project-1', 'import-1')
  })
})

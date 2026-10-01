/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: { workspaceImport: { findFirst: mocks.findFirst } } }))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

import { POST } from './route'

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/projects/project-1/imports/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
})

describe('POST /api/projects/[id]/imports/compare', () => {
  test('returns a deterministic manifest delta against the latest completed root', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'previous-1',
      manifest: [
        { relativePath: 'same.bin', size: 2, lastModified: 1 },
        { relativePath: 'removed.bin', size: 2, lastModified: 1 },
      ],
    })

    const response = await POST(request({
      rootName: 'ExampleApp',
      files: [
        { relativePath: 'same.bin', size: 2, lastModified: 1 },
        { relativePath: 'added.bin', size: 1, lastModified: 1 },
      ],
    }), { params: Promise.resolve({ id: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      rootName: 'ExampleApp',
      comparison: {
        mode: 'MANIFEST',
        previousImportId: 'previous-1',
        addedCount: 1,
        removedCount: 1,
        unchangedCount: 1,
      },
    })
  })

  test('rejects hostile manifest paths without querying prior imports', async () => {
    const response = await POST(request({
      rootName: 'ExampleApp',
      files: [{ relativePath: '../../etc/passwd', size: 1 }],
    }), { params: Promise.resolve({ id: 'project-1' }) })

    expect(response.status).toBe(400)
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })
})

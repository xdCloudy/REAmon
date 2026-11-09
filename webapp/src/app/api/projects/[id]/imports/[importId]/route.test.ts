/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccessStrict: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: { workspaceImport: { findFirst: mocks.findFirst } },
}))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccessStrict: mocks.requireProjectAccessStrict,
}))

import { GET } from './route'

function params() {
  return { params: Promise.resolve({ id: 'project-1', importId: 'import-1' }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccessStrict.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.findFirst.mockResolvedValue({
    id: 'import-1',
    sourceType: 'BROWSER_DIRECTORY',
    rootName: 'ExampleApp',
    status: 'UPLOADING',
    totalFiles: 2,
    completedFiles: 1,
    failedFiles: 0,
    totalBytes: 100n,
    uploadedBytes: 40n,
    errorSummary: null,
    completedAt: null,
    rootTargetId: null,
    manifest: [{ relativePath: 'secret/Source.java' }, { relativePath: 'src/Done.java' }],
    artifacts: [{ relativePath: 'src/Done.java' }],
    rootTarget: null,
  })
})

describe('GET /api/projects/[id]/imports/[importId]', () => {
  test('denies foreign project access before reading import metadata', async () => {
    const { NextResponse } = await import('next/server')
    mocks.requireProjectAccessStrict.mockResolvedValueOnce(NextResponse.json({ error: 'Not found' }, { status: 404 }))

    const response = await GET(new Request('http://localhost'), params())

    expect(response.status).toBe(404)
    expect(mocks.findFirst).not.toHaveBeenCalled()
  })

  test('returns only missing manifest paths for an authorized project import', async () => {
    const response = await GET(new Request('http://localhost'), params())

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({
      id: 'import-1',
      status: 'UPLOADING',
      totalBytes: 100,
      uploadedBytes: 40,
      missingPaths: ['secret/Source.java'],
      profile: null,
    })
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'import-1', projectId: 'project-1' },
    }))
  })
})

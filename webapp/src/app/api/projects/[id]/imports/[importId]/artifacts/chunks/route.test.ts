/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  workspaceImportFindFirst: vi.fn(),
  workspaceImportUpdateMany: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  receiveArtifactChunk: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: { workspaceImport: { findFirst: mocks.workspaceImportFindFirst, updateMany: mocks.workspaceImportUpdateMany } },
}))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))
vi.mock('@/lib/reamon/artifact-import-commit', () => ({
  receiveArtifactChunk: mocks.receiveArtifactChunk,
}))

import { PUT } from './route'

function params() {
  return { params: Promise.resolve({ id: 'project-1', importId: 'import-1' }) }
}

function request(chunks: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Request('http://localhost/api/projects/project-1/imports/import-1/artifacts/chunks?relativePath=bin%2Fapp.exe', {
    method: 'PUT',
    headers: { 'x-reamon-upload-offset': '0', 'x-reamon-upload-size': '3' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.workspaceImportFindFirst.mockResolvedValue({
    status: 'PENDING', sourceType: 'BROWSER_DIRECTORY',
    manifest: [{ relativePath: 'bin/app.exe', size: 3 }],
  })
  mocks.workspaceImportUpdateMany.mockResolvedValue({ count: 1 })
  mocks.receiveArtifactChunk.mockResolvedValue(3)
})

describe('PUT /api/projects/[id]/imports/[importId]/artifacts/chunks', () => {
  test('accepts a valid streamed chunk when Content-Length is absent', async () => {
    const response = await PUT(request([new Uint8Array([1]), new Uint8Array([2, 3])]), params())

    expect(response.status).toBe(200)
    expect(mocks.workspaceImportUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { notIn: ['COMPLETED', 'CANCELLED', 'CANCELLING', 'FINALIZING'] } }),
      data: { updatedAt: expect.any(Date) },
    }))
    expect(mocks.receiveArtifactChunk).toHaveBeenCalledWith(expect.objectContaining({
      relativePath: 'bin/app.exe', offset: 0, totalSize: 3,
      bytes: new Uint8Array([1, 2, 3]),
    }))
  })

  test('rejects oversized streamed chunks without a Content-Length header', async () => {
    const response = await PUT(request([new Uint8Array(16 * 1024 * 1024 + 1)]), params())

    expect(response.status).toBe(413)
    expect(mocks.receiveArtifactChunk).not.toHaveBeenCalled()
  })

  test('does not accept a chunk after an import was cancelled', async () => {
    mocks.workspaceImportFindFirst.mockResolvedValueOnce({
      status: 'CANCELLED', sourceType: 'BROWSER_DIRECTORY',
      manifest: [{ relativePath: 'bin/app.exe', size: 3 }],
    })
    mocks.workspaceImportUpdateMany.mockResolvedValueOnce({ count: 0 })

    const response = await PUT(request([new Uint8Array([1, 2, 3])]), params())

    expect(response.status).toBe(409)
    expect(mocks.receiveArtifactChunk).not.toHaveBeenCalled()
  })
})

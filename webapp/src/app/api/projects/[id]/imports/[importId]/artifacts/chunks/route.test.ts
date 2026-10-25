/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  workspaceImportFindFirst: vi.fn(),
  workspaceImportUpdateMany: vi.fn(),
  workspaceImportUpdate: vi.fn(),
  artifactFindFirst: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  receiveArtifactChunk: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    workspaceImport: { findFirst: mocks.workspaceImportFindFirst, updateMany: mocks.workspaceImportUpdateMany },
    artifact: { findFirst: mocks.artifactFindFirst },
    $transaction: mocks.transaction,
  },
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
  mocks.receiveArtifactChunk.mockResolvedValue({ receivedBytes: 3, addedBytes: 3 })
  mocks.workspaceImportUpdate.mockResolvedValue({ id: 'import-1' })
  mocks.artifactFindFirst.mockResolvedValue(null)
  mocks.queryRaw.mockResolvedValue([])
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
    $queryRaw: mocks.queryRaw,
    artifact: { findFirst: mocks.artifactFindFirst },
    workspaceImport: { updateMany: mocks.workspaceImportUpdateMany, update: mocks.workspaceImportUpdate },
  }))
})

describe('PUT /api/projects/[id]/imports/[importId]/artifacts/chunks', () => {
  test('accepts a valid streamed chunk when Content-Length is absent', async () => {
    const response = await PUT(request([new Uint8Array([1]), new Uint8Array([2, 3])]), params())

    expect(response.status).toBe(200)
    expect(mocks.queryRaw).toHaveBeenCalledOnce()
    expect(mocks.workspaceImportUpdate).toHaveBeenCalledWith({
      where: { id: 'import-1' }, data: { uploadedBytes: { increment: 3n } },
    })
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

  test('acknowledges retries for an already committed path without writing or counting it twice', async () => {
    mocks.artifactFindFirst.mockResolvedValueOnce({ id: 'artifact-1' })

    const response = await PUT(request([new Uint8Array([1, 2, 3])]), params())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ receivedBytes: 3 })
    expect(mocks.receiveArtifactChunk).not.toHaveBeenCalled()
    expect(mocks.workspaceImportUpdate).not.toHaveBeenCalled()
  })
})

/** @vitest-environment node */
import { describe, expect, test, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  workspaceImportFindFirst: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  resolveServerSourceArtifact: vi.fn(),
  commitArtifactFromPath: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: { workspaceImport: { findFirst: mocks.workspaceImportFindFirst } },
}))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))
vi.mock('@/lib/reamon/server-import', () => ({
  SERVER_DIRECTORY_SOURCE_TYPE: 'SERVER_DIRECTORY',
  ServerSourceError: class ServerSourceError extends Error {
    status = 400
  },
  resolveServerSourceArtifact: mocks.resolveServerSourceArtifact,
}))
vi.mock('@/lib/reamon/artifact-import-commit', () => ({
  commitArtifactFromPath: mocks.commitArtifactFromPath,
}))

import { POST } from './route'

function params() {
  return { params: Promise.resolve({ id: 'project-1', importId: 'import-1' }) }
}

function serverRequest(relativePath: string): Request {
  return new Request(`http://localhost/api/projects/project-1/imports/import-1/artifacts?relativePath=${encodeURIComponent(relativePath)}`, {
    method: 'POST',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.workspaceImportFindFirst.mockResolvedValue({
    id: 'import-1', projectId: 'project-1', status: 'PENDING',
    sourceType: 'SERVER_DIRECTORY', metadata: { serverSourcePath: '/source' },
    manifest: [{ relativePath: 'bin/app.exe', size: 3 }],
  })
  mocks.resolveServerSourceArtifact.mockResolvedValue('/source/bin/app.exe')
  mocks.commitArtifactFromPath.mockResolvedValue({
    artifact: { id: 'artifact-1', sizeBytes: 3, sha256: 'hash-1' },
    profile: { format: 'pe-exe' }, capabilities: [],
  })
})

describe('POST /api/projects/[id]/imports/[importId]/artifacts', () => {
  test('imports a server-mounted artifact by manifest path', async () => {
    const response = await POST(serverRequest('bin/app.exe'), params())

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      artifact: { id: 'artifact-1', relativePath: 'bin/app.exe', sizeBytes: 3, sha256: 'hash-1' },
    })
    expect(mocks.resolveServerSourceArtifact).toHaveBeenCalledWith('/source', 'bin/app.exe', 3)
    expect(mocks.commitArtifactFromPath).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1', importId: 'import-1', relativePath: 'bin/app.exe',
      sourcePath: '/source/bin/app.exe', sourceType: 'SERVER_DIRECTORY', cleanupSource: false,
    }))
  })

  test('rejects legacy multipart browser uploads before parsing their body', async () => {
    mocks.workspaceImportFindFirst.mockResolvedValueOnce({
      id: 'import-1', projectId: 'project-1', status: 'PENDING',
      sourceType: 'BROWSER_DIRECTORY', manifest: [{ relativePath: 'bin/app.exe', size: 3 }],
    })
    const form = new FormData()
    form.set('relativePath', 'bin/app.exe')
    form.set('file', new File(['abc'], 'app.exe'))
    const request = new Request('http://localhost/api/projects/project-1/imports/import-1/artifacts', {
      method: 'POST', body: form,
    })
    const parseBody = vi.spyOn(request, 'formData')

    const response = await POST(request, params())

    expect(response.status).toBe(415)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('resumable chunk') })
    expect(parseBody).not.toHaveBeenCalled()
    expect(mocks.commitArtifactFromPath).not.toHaveBeenCalled()
  })

  test('rejects paths missing from a server import manifest', async () => {
    const response = await POST(serverRequest('other/app.exe'), params())

    expect(response.status).toBe(400)
    expect(mocks.resolveServerSourceArtifact).not.toHaveBeenCalled()
  })

  test.each([
    ['ENOSPC', Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })],
    ['nested EDQUOT', new Error('copy failed', { cause: Object.assign(new Error('quota exceeded'), { code: 'EDQUOT' }) })],
  ])('reports %s during artifact copy as recoverable storage pressure', async (_label, error) => {
    mocks.commitArtifactFromPath.mockRejectedValueOnce(error)

    const response = await POST(serverRequest('bin/app.exe'), params())

    expect(response.status).toBe(507)
    expect(await response.json()).toEqual({
      error: 'Artifact storage is full; free space or increase the available volume capacity, then retry',
    })
  })

  test('keeps unrelated artifact import errors as server failures', async () => {
    mocks.commitArtifactFromPath.mockRejectedValueOnce(new Error('unexpected commit failure'))

    const response = await POST(serverRequest('bin/app.exe'), params())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to upload artifact' })
  })
})

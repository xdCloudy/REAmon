/**
 * Route-level coverage for bounded workspace artifact uploads.
 *
 * @vitest-environment node
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  workspaceImportFindFirst: vi.fn(),
  artifactFindFirst: vi.fn(),
  transaction: vi.fn(),
  targetCreate: vi.fn(),
  artifactCreate: vi.fn(),
  artifactUpdate: vi.fn(),
  evidenceDeleteMany: vi.fn(),
  evidenceCreate: vi.fn(),
  activityCreate: vi.fn(),
  importUpdateMany: vi.fn(),
  importUpdate: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  profileArtifact: vi.fn(),
  resolveCapabilities: vi.fn(),
  isLogicalTargetCandidate: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    workspaceImport: { findFirst: mocks.workspaceImportFindFirst },
    artifact: { findFirst: mocks.artifactFindFirst },
    $transaction: mocks.transaction,
  },
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

vi.mock('@/lib/reamon/profiler', () => ({ profileArtifact: mocks.profileArtifact }))
vi.mock('@/lib/reamon/capabilities', () => ({ resolveCapabilities: mocks.resolveCapabilities }))
vi.mock('@/lib/reamon/inventory', () => ({ isLogicalTargetCandidate: mocks.isLogicalTargetCandidate }))

import { POST } from './route'

let storageRoot = ''
let sourceRoot = ''

function params() {
  return { params: Promise.resolve({ id: 'project-1', importId: 'import-1' }) }
}

function uploadRequest(relativePath: string, contents = 'abc'): Request {
  const form = new FormData()
  form.set('relativePath', relativePath)
  form.set('file', new File([contents], path.basename(relativePath), { type: 'application/octet-stream' }))
  return new Request('http://localhost/api/projects/project-1/imports/import-1/artifacts', {
    method: 'POST',
    body: form,
  })
}

function serverRequest(relativePath: string): Request {
  const form = new FormData()
  form.set('relativePath', relativePath)
  return new Request('http://localhost/api/projects/project-1/imports/import-1/artifacts', {
    method: 'POST',
    body: form,
  })
}

const profile = {
  targetType: 'FILE',
  format: 'pe-exe',
  mimeType: 'application/octet-stream',
  extension: 'exe',
  architecture: 'x86_64',
  platform: 'windows',
}

beforeEach(async () => {
  vi.clearAllMocks()
  storageRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-import-route-'))
  sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-server-import-'))
  vi.stubEnv('REAMON_ARTIFACTS_PATH', storageRoot)
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.workspaceImportFindFirst.mockResolvedValue({
    id: 'import-1',
    projectId: 'project-1',
    rootTargetId: 'root-target-1',
    status: 'PENDING',
    manifest: [{ relativePath: 'bin/app.exe', size: 3 }],
  })
  mocks.artifactFindFirst.mockResolvedValue(null)
  mocks.profileArtifact.mockReturnValue(profile)
  mocks.resolveCapabilities.mockReturnValue([{ toolId: 'reamon-profiler', capabilities: ['identify'] }])
  mocks.isLogicalTargetCandidate.mockReturnValue(true)
  mocks.targetCreate.mockResolvedValue({ id: 'target-1' })
  mocks.artifactCreate.mockResolvedValue({ id: 'artifact-1', sizeBytes: 3, sha256: 'hash-1' })
  mocks.artifactUpdate.mockResolvedValue({ id: 'artifact-1', sizeBytes: 3, sha256: 'hash-2' })
  mocks.evidenceDeleteMany.mockResolvedValue({ count: 0 })
  mocks.evidenceCreate.mockResolvedValue({ id: 'evidence-1' })
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
  mocks.importUpdateMany.mockResolvedValue({ count: 1 })
  mocks.importUpdate.mockResolvedValue({ id: 'import-1' })
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
    target: { create: mocks.targetCreate },
    artifact: { findFirst: mocks.artifactFindFirst, create: mocks.artifactCreate, update: mocks.artifactUpdate },
    evidence: { deleteMany: mocks.evidenceDeleteMany, create: mocks.evidenceCreate },
    workspaceActivity: { create: mocks.activityCreate },
    workspaceImport: { updateMany: mocks.importUpdateMany, update: mocks.importUpdate },
  }))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true })
})

describe('POST /api/projects/[id]/imports/[importId]/artifacts', () => {
  test('hashes and stores a manifest-backed artifact at its opaque path', async () => {
    const response = await POST(uploadRequest('bin/app.exe'), params())

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      artifact: {
        id: 'artifact-1',
        relativePath: 'bin/app.exe',
        sizeBytes: 3,
        sha256: 'hash-1',
      },
    })
    expect(mocks.artifactCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId: 'project-1',
        importId: 'import-1',
        relativePath: 'bin/app.exe',
        parentPath: 'bin',
        storagePath: expect.stringMatching(/^project-1[\\/]import-1[\\/][a-f0-9-]+[\\/][a-f0-9]{64}$/),
      }),
    }))
    const storagePath = mocks.artifactCreate.mock.calls[0][0].data.storagePath as string
    const stored = await readFile(path.join(storageRoot, storagePath), 'utf8')
    expect(stored).toBe('abc')
  })

  test.each([
    ['path not in manifest', 'other/app.exe', 'abc'],
    ['manifest size mismatch', 'bin/app.exe', 'too-large'],
  ])('rejects %s before writing storage', async (_label, relativePath, contents) => {
    const response = await POST(uploadRequest(relativePath, contents), params())

    expect(response.status).toBe(400)
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.artifactFindFirst).not.toHaveBeenCalled()
  })

  test('retries an existing path idempotently instead of creating a duplicate artifact', async () => {
    const previousStoragePath = 'project-1/import-1/artifact-existing/old-content'
    await mkdir(path.join(storageRoot, path.dirname(previousStoragePath)), { recursive: true })
    await writeFile(path.join(storageRoot, previousStoragePath), 'previous')
    mocks.artifactFindFirst.mockResolvedValue({
      id: 'artifact-existing',
      storagePath: previousStoragePath,
      targetId: 'target-existing',
      sizeBytes: 3,
    })

    const response = await POST(uploadRequest('bin/app.exe'), params())

    expect(response.status).toBe(200)
    expect(mocks.artifactCreate).not.toHaveBeenCalled()
    expect(mocks.artifactUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'artifact-existing' },
      data: expect.objectContaining({ relativePath: 'bin/app.exe' }),
    }))
    expect(mocks.importUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'import-1', status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      data: { status: 'UPLOADING' },
    }))
    await expect(readFile(path.join(storageRoot, previousStoragePath), 'utf8')).rejects.toThrow()
    expect(mocks.importUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(mocks.artifactFindFirst.mock.invocationCallOrder[0])
  })

  test('does not reopen an import finalized while bytes were being written', async () => {
    mocks.importUpdateMany.mockResolvedValue({ count: 0 })

    const response = await POST(uploadRequest('bin/app.exe'), params())

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Import is no longer accepting artifacts' })
    expect(mocks.artifactFindFirst).not.toHaveBeenCalled()
    expect(mocks.artifactCreate).not.toHaveBeenCalled()
  })

  test('keeps the previous bytes when an existing-artifact retry cannot commit', async () => {
    const previousStoragePath = 'project-1/import-1/artifact-existing/old-content'
    await mkdir(path.join(storageRoot, path.dirname(previousStoragePath)), { recursive: true })
    await writeFile(path.join(storageRoot, previousStoragePath), 'previous')
    mocks.artifactFindFirst.mockResolvedValue({
      id: 'artifact-existing',
      storagePath: previousStoragePath,
      targetId: 'target-existing',
      sizeBytes: 8,
    })
    mocks.transaction.mockRejectedValueOnce(new Error('database unavailable'))

    const response = await POST(uploadRequest('bin/app.exe'), params())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to upload artifact' })
    expect(await readFile(path.join(storageRoot, previousStoragePath), 'utf8')).toBe('previous')
    expect(mocks.artifactUpdate).not.toHaveBeenCalled()
  })

  test('reads an allowlisted server artifact without accepting an uploaded file', async () => {
    await mkdir(path.join(sourceRoot, 'bin'), { recursive: true })
    await writeFile(path.join(sourceRoot, 'bin', 'app.exe'), 'abc')
    vi.stubEnv('REAMON_SERVER_SOURCE_ROOTS', sourceRoot)
    mocks.workspaceImportFindFirst.mockResolvedValueOnce({
      id: 'import-1',
      projectId: 'project-1',
      rootTargetId: 'root-target-1',
      status: 'PENDING',
      sourceType: 'SERVER_DIRECTORY',
      metadata: { serverSourcePath: sourceRoot },
      manifest: [{ relativePath: 'bin/app.exe', size: 3 }],
    })

    const response = await POST(serverRequest('bin/app.exe'), params())

    expect(response.status).toBe(201)
    const storagePath = mocks.artifactCreate.mock.calls[0][0].data.storagePath as string
    expect(await readFile(path.join(storageRoot, storagePath), 'utf8')).toBe('abc')
    expect(mocks.profileArtifact).toHaveBeenCalledWith(expect.any(Uint8Array), 'bin/app.exe', 'application/octet-stream')
  })
})

/**
 * Route-level coverage for resumable import finalization.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  workspaceImportFindFirst: vi.fn(),
  workspaceImportUpdate: vi.fn(),
  workspaceImportUpdateMany: vi.fn(),
  transaction: vi.fn(),
  targetUpdate: vi.fn(),
  activityCreate: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    workspaceImport: {
      findFirst: mocks.workspaceImportFindFirst,
      update: mocks.workspaceImportUpdate,
      updateMany: mocks.workspaceImportUpdateMany,
    },
    $transaction: mocks.transaction,
  },
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

import { POST } from './route'

function params() {
  return { params: Promise.resolve({ id: 'project-1', importId: 'import-1' }) }
}

function request(): Request {
  return new Request('http://localhost/api/projects/project-1/imports/import-1/finalize', { method: 'POST' })
}

const artifact = {
  id: 'artifact-1',
  relativePath: 'bin/app.exe',
  sizeBytes: 3,
  profile: {
    targetType: 'FILE',
    format: 'pe-exe',
    mimeType: 'application/octet-stream',
    extension: 'exe',
    architecture: 'x86_64',
    platform: 'windows',
    runtimes: [],
    embeddedArtifacts: [],
    entropy: null,
    metadata: {},
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.workspaceImportUpdate.mockResolvedValue({ id: 'import-1' })
  mocks.workspaceImportUpdateMany.mockResolvedValue({ count: 1 })
  mocks.targetUpdate.mockResolvedValue({ id: 'root-target-1' })
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
    workspaceImport: {
      findFirst: mocks.workspaceImportFindFirst,
      update: mocks.workspaceImportUpdate,
      updateMany: mocks.workspaceImportUpdateMany,
    },
    target: { update: mocks.targetUpdate },
    workspaceActivity: { create: mocks.activityCreate },
  }))
})

describe('POST /api/projects/[id]/imports/[importId]/finalize', () => {
  test('marks an incomplete import failed and reports missing paths', async () => {
    mocks.workspaceImportFindFirst.mockResolvedValueOnce({
      id: 'import-1',
      projectId: 'project-1',
      rootTarget: { id: 'root-target-1' },
      rootName: 'ExampleApp',
      status: 'UPLOADING',
      manifest: [
        { relativePath: 'bin/app.exe', size: 3 },
        { relativePath: 'plugins/audio.dll', size: 2 },
      ],
      artifacts: [artifact],
    })

    const response = await POST(request(), params())

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      status: 'FAILED',
      missingPaths: ['plugins/audio.dll'],
    })
    expect(mocks.workspaceImportUpdateMany).toHaveBeenCalledWith({
      where: { id: 'import-1', projectId: 'project-1', status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      data: { status: 'FINALIZING' },
    })
    expect(mocks.workspaceImportUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'import-1' },
      data: expect.objectContaining({ status: 'FAILED', failedFiles: 1 }),
    }))
    expect(mocks.workspaceImportUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(mocks.workspaceImportFindFirst.mock.invocationCallOrder[0])
  })

  test('profiles the aggregate and completes an import only after every path exists', async () => {
    mocks.workspaceImportFindFirst
      .mockResolvedValueOnce({
      id: 'import-1',
      projectId: 'project-1',
      rootTarget: { id: 'root-target-1' },
      rootName: 'ExampleApp',
      status: 'UPLOADING',
      manifest: [{ relativePath: 'bin/app.exe', size: 3 }],
      artifacts: [artifact],
      })
      .mockResolvedValueOnce(null)
    mocks.workspaceImportUpdate.mockResolvedValue({ id: 'import-1', status: 'COMPLETED', rootTargetId: 'root-target-1', completedFiles: 1 })

    const response = await POST(request(), params())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'COMPLETED',
      importId: 'import-1',
      rootTargetId: 'root-target-1',
      completedFiles: 1,
      uploadedBytes: 3,
      missingPaths: [],
    })
    expect(mocks.targetUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'root-target-1' },
      data: expect.objectContaining({ status: 'IDENTIFIED' }),
    }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'workspace.import.completed' }),
    }))
    expect(mocks.workspaceImportUpdateMany).toHaveBeenCalledBefore(mocks.workspaceImportFindFirst)
  })

  test('reads artifact inventory after acquiring the import row lock', async () => {
    mocks.workspaceImportFindFirst.mockResolvedValueOnce({
      id: 'import-1', projectId: 'project-1', rootTarget: { id: 'root-target-1' },
      rootName: 'ExampleApp', status: 'FINALIZING', manifest: [{ relativePath: 'bin/app.exe', size: 3 }],
      artifacts: [artifact],
    }).mockResolvedValueOnce(null)
    mocks.workspaceImportUpdate.mockResolvedValue({ id: 'import-1', status: 'COMPLETED', rootTargetId: 'root-target-1', completedFiles: 1 })

    const response = await POST(request(), params())

    expect(response.status).toBe(200)
    expect(mocks.workspaceImportUpdateMany).toHaveBeenCalledBefore(mocks.workspaceImportFindFirst)
    expect(mocks.workspaceImportUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'COMPLETED', completedFiles: 1 }),
    }))
  })

  test('does not downgrade an import completed before the finalizer acquired its lock', async () => {
    mocks.workspaceImportUpdateMany.mockResolvedValueOnce({ count: 0 })
    mocks.workspaceImportFindFirst.mockResolvedValueOnce({ id: 'import-1', status: 'COMPLETED' })

    const response = await POST(request(), params())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'COMPLETED', importId: 'import-1', missingPaths: [] })
    expect(mocks.workspaceImportUpdate).not.toHaveBeenCalled()
    expect(mocks.targetUpdate).not.toHaveBeenCalled()
  })

  test('does not reopen a cancelled import during finalization', async () => {
    mocks.workspaceImportUpdateMany.mockResolvedValueOnce({ count: 0 })
    mocks.workspaceImportFindFirst.mockResolvedValueOnce({ id: 'import-1', status: 'CANCELLED' })

    const response = await POST(request(), params())

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Cancelled imports cannot be finalized' })
    expect(mocks.workspaceImportUpdate).not.toHaveBeenCalled()
    expect(mocks.targetUpdate).not.toHaveBeenCalled()
  })
})

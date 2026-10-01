/**
 * Route-level coverage for workspace import creation.
 *
 * These tests intentionally stop at the Prisma transaction boundary: the
 * browser-import client is already covered separately, while this contract is
 * where hostile paths, duplicate logical entries, and import limits must be
 * rejected before any workspace rows are created.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  targetCreate: vi.fn(),
  importCreate: vi.fn(),
  activityCreate: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    $transaction: mocks.transaction,
  },
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

import { POST } from './route'

function requestFor(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/projects/project-1/imports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function params() {
  return { params: Promise.resolve({ id: 'project-1' }) }
}

const files = [
  { relativePath: 'bin\\x64\\app.exe', size: 3, lastModified: 1790872012000 },
  { relativePath: 'plugins/audio.dll', size: 2, lastModified: null },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.targetCreate.mockResolvedValue({ id: 'root-target-1' })
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
  mocks.importCreate.mockResolvedValue({
    id: 'import-1',
    sourceType: 'BROWSER_DIRECTORY',
    rootName: 'ExampleApp',
    status: 'PENDING',
    totalFiles: 2,
    completedFiles: 0,
    failedFiles: 0,
    totalBytes: 5n,
    uploadedBytes: 0n,
    errorSummary: '',
    completedAt: null,
    rootTargetId: 'root-target-1',
    rootTarget: { profile: {} },
    manifest: [
      { relativePath: 'bin/x64/app.exe', size: 3, lastModified: 1790872012000 },
      { relativePath: 'plugins/audio.dll', size: 2, lastModified: null },
    ],
    artifacts: [],
  })
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
    target: { create: mocks.targetCreate },
    workspaceImport: { create: mocks.importCreate },
    workspaceActivity: { create: mocks.activityCreate },
  }))
})

describe('POST /api/projects/[id]/imports', () => {
  test('creates a directory root and canonicalizes browser paths', async () => {
    const response = await POST(requestFor({ rootName: 'ExampleApp', files }), params())

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      id: 'import-1',
      rootName: 'ExampleApp',
      totalFiles: 2,
      totalBytes: 5,
      missingPaths: ['bin/x64/app.exe', 'plugins/audio.dll'],
    })
    expect(mocks.targetCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId: 'project-1',
        name: 'ExampleApp',
        targetType: 'DIRECTORY',
        locator: 'directory:ExampleApp',
      }),
    }))
    expect(mocks.importCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId: 'project-1',
        rootTargetId: 'root-target-1',
        totalFiles: 2,
        totalBytes: 5n,
        manifest: [
          { relativePath: 'bin/x64/app.exe', size: 3, lastModified: 1790872012000 },
          { relativePath: 'plugins/audio.dll', size: 2, lastModified: null },
        ],
      }),
    }))
  })

  test.each([
    ['duplicate paths after normalization', [
      { relativePath: 'bin/app.exe', size: 1 },
      { relativePath: 'bin\\app.exe', size: 1 },
    ]],
    ['path traversal', [{ relativePath: '../secrets.txt', size: 1 }]],
    ['absolute Unix path', [{ relativePath: '/etc/passwd', size: 1 }]],
    ['absolute Windows path', [{ relativePath: 'C:\\Windows\\system32.dll', size: 1 }]],
  ])('rejects %s before creating workspace rows', async (_label, invalidFiles) => {
    const response = await POST(requestFor({ rootName: 'ExampleApp', files: invalidFiles }), params())

    expect(response.status).toBe(400)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  test('rejects an import over the configured file limit', async () => {
    vi.stubEnv('REAMON_MAX_IMPORT_FILES', '1')

    const response = await POST(requestFor({ rootName: 'ExampleApp', files }), params())

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/file limit/i)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  test('rejects unsupported source types', async () => {
    const response = await POST(requestFor({ rootName: 'ExampleApp', sourceType: 'SERVER_MOUNT', files }), params())

    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/unsupported/i)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})

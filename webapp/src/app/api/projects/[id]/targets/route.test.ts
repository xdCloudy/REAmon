/** @vitest-environment node */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  artifactFindMany: vi.fn(),
  taskFindFirst: vi.fn(),
  targetFindFirst: vi.fn(),
  targetCreate: vi.fn(),
  targetUpdate: vi.fn(),
  artifactCreate: vi.fn(),
  evidenceCreate: vi.fn(),
  activityCreate: vi.fn(),
  provenanceUpsert: vi.fn(),
  transaction: vi.fn(),
  profileArtifact: vi.fn(),
  resolveCapabilities: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))
vi.mock('@/lib/prisma', () => ({
  default: {
    artifact: { findMany: mocks.artifactFindMany },
    task: { findFirst: mocks.taskFindFirst },
    target: { findFirst: mocks.targetFindFirst },
    $transaction: mocks.transaction,
  },
}))
vi.mock('@/lib/reamon/profiler', () => ({ profileArtifact: mocks.profileArtifact }))
vi.mock('@/lib/reamon/capabilities', () => ({ resolveCapabilities: mocks.resolveCapabilities }))

import { POST } from './route'

let storageRoot = ''
const params = { params: Promise.resolve({ id: 'project-1' }) }
const profile = {
  format: 'binary',
  mimeType: 'application/octet-stream',
  extension: 'bin',
  targetType: 'FILE',
}
const target = {
  id: 'target-1',
  name: 'derived.bin',
  targetType: 'FILE',
  status: 'IDENTIFIED',
  profile,
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'output-1',
    name: 'derived.bin',
    originalName: 'derived.bin',
    relativePath: 'derived.bin',
    parentPath: '',
    sizeBytes: 5,
    sha256: 'output-hash',
    mimeType: profile.mimeType,
    extension: profile.extension,
    status: 'IDENTIFIED',
    ...overrides,
  }
}

function request(fields: Record<string, string> = {}) {
  const form = new FormData()
  form.set('file', new File(['bytes'], 'derived.bin', { type: profile.mimeType }))
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return new Request('http://localhost/api/projects/project-1/targets', { method: 'POST', body: form })
}

beforeEach(async () => {
  vi.clearAllMocks()
  storageRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-target-upload-'))
  vi.stubEnv('REAMON_ARTIFACTS_PATH', storageRoot)
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.artifactFindMany.mockResolvedValue([])
  mocks.taskFindFirst.mockResolvedValue(null)
  mocks.targetFindFirst.mockResolvedValue(null)
  mocks.profileArtifact.mockReturnValue(profile)
  mocks.resolveCapabilities.mockReturnValue([])
  mocks.targetCreate.mockResolvedValue(target)
  mocks.targetUpdate.mockResolvedValue(target)
  mocks.artifactCreate.mockResolvedValue(artifact())
  mocks.evidenceCreate.mockResolvedValue({ id: 'evidence-1' })
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
  mocks.provenanceUpsert.mockResolvedValue({ id: 'lineage-1' })
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    target: { create: mocks.targetCreate, update: mocks.targetUpdate },
    artifact: { create: mocks.artifactCreate },
    artifactProvenance: { upsert: mocks.provenanceUpsert },
    evidence: { create: mocks.evidenceCreate },
    workspaceActivity: { create: mocks.activityCreate },
  }))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
})

describe('POST /api/projects/[id]/targets derived provenance', () => {
  test('records every project-scoped source and the producing task', async () => {
    mocks.artifactFindMany.mockResolvedValue([
      { id: 'source-a', relativePath: 'input/a.bin', sha256: 'a'.repeat(64) },
      { id: 'source-b', relativePath: 'input/b.bin', sha256: 'b'.repeat(64) },
    ])
    mocks.taskFindFirst.mockResolvedValue({ artifactId: 'source-a' })

    const response = await POST(request({
      sourceArtifactIds: JSON.stringify(['source-a', 'source-b']),
      sourceTaskId: 'task-1',
    }), params)

    expect(response.status).toBe(201)
    expect(mocks.artifactFindMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1', id: { in: ['source-a', 'source-b'] } },
      select: { id: true, relativePath: true, sha256: true },
    })
    expect(mocks.provenanceUpsert).toHaveBeenCalledTimes(2)
    expect(mocks.provenanceUpsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      create: expect.objectContaining({
        projectId: 'project-1',
        artifactId: 'output-1',
        sourceArtifactId: 'source-a',
        taskId: 'task-1',
        relation: 'DERIVED_FROM',
      }),
    }))
    expect(await response.json()).toMatchObject({
      artifact: {
        provenance: [
          { sourceArtifactId: 'source-a', sourceRelativePath: 'input/a.bin', taskId: 'task-1' },
          { sourceArtifactId: 'source-b', sourceRelativePath: 'input/b.bin', taskId: 'task-1' },
        ],
      },
    })
  })

  test('rejects a task that is not attached to one of the source artifacts before writing', async () => {
    mocks.artifactFindMany.mockResolvedValue([{ id: 'source-a', relativePath: 'input/a.bin', sha256: 'a'.repeat(64) }])
    mocks.taskFindFirst.mockResolvedValue({ artifactId: 'different-source' })

    const response = await POST(request({
      sourceArtifactIds: JSON.stringify(['source-a']),
      sourceTaskId: 'task-1',
    }), params)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'sourceTaskId must belong to one of the source artifacts' })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.artifactCreate).not.toHaveBeenCalled()
  })

  test('rejects missing project-scoped sources before writing', async () => {
    mocks.artifactFindMany.mockResolvedValue([])

    const response = await POST(request({ sourceArtifactIds: JSON.stringify(['not-in-project']) }), params)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'One or more source artifacts were not found in this project' })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})

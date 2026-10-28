import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  getActiveWorkspaceImportSelection: vi.fn(),
  taskFindFirst: vi.fn(),
  investigationFindFirst: vi.fn(),
  investigationFindUnique: vi.fn(),
  investigationCreate: vi.fn(),
  observationCount: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    task: { findFirst: mocks.taskFindFirst },
    reamonInvestigationCase: {
      findFirst: mocks.investigationFindFirst,
      findUnique: mocks.investigationFindUnique,
      create: mocks.investigationCreate,
    },
    reamonObservation: { count: mocks.observationCount },
  },
}))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: mocks.getActiveWorkspaceImportSelection }))

import { GET, POST } from './route'

const params = Promise.resolve({ id: 'project-1', taskId: 'task-1' })

describe('/api/projects/[id]/workspace/tasks/[taskId]/investigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
    mocks.requireProjectAccess.mockResolvedValue({ projectId: 'project-1' })
    mocks.getActiveWorkspaceImportSelection.mockResolvedValue({ artifactWhere: { id: 'artifact-1' } })
    mocks.investigationFindFirst.mockResolvedValue(null)
    mocks.investigationFindUnique.mockResolvedValue(null)
    mocks.observationCount.mockResolvedValue(3)
  })

  test('loads only the case in the authorized project', async () => {
    mocks.investigationFindFirst.mockResolvedValue({ id: 'case-1', status: 'QUEUED' })

    const response = await GET(new Request('http://local'), { params })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ investigation: { id: 'case-1', status: 'QUEUED' } })
    expect(mocks.investigationFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: 'project-1', taskId: 'task-1' } }))
  })

  test('requires an authenticated user before reading the queue', async () => {
    mocks.requireEffectiveUser.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

    const response = await GET(new Request('http://local'), { params })

    expect(response.status).toBe(401)
    expect(mocks.investigationFindFirst).not.toHaveBeenCalled()
  })

  test('queues a failed active-artifact decompilation with immutable run provenance', async () => {
    mocks.taskFindFirst.mockResolvedValue({
      id: 'task-1', projectId: 'project-1', artifactId: 'artifact-1', capability: 'decompile', status: 'FAILED',
      title: 'Decompile app', progressMessage: 'Parsing methods', error: 'Provider timed out', result: {
        partial: true,
        detail: 'ignored',
        providerFailure: {
          schemaVersion: 1,
          runToken: 'a'.repeat(36),
          inputArtifactSha256: 'B'.repeat(64),
          observationCount: 4,
          partialCodeUnitCount: 2,
          partialUnits: [
            { type: 'function', key: 'fn:entry', label: 'entry', attributes: { address: '0x100', language: 'c' } },
            { type: 'unknown', key: 'drop-me', label: 'bad', attributes: {} },
          ],
        },
      },
      startedAt: new Date('2026-10-28T08:00:00.000Z'), completedAt: new Date('2026-10-28T08:01:00.000Z'),
      createdAt: new Date('2026-10-28T07:59:00.000Z'), artifact: { sha256: 'A'.repeat(64) },
      provider: { pluginId: 'reamon-jadx', version: '1.2.3' },
    })
    mocks.investigationCreate.mockImplementation(async ({ data }) => ({ id: 'case-1', status: data.status, revision: 1, createdAt: new Date('2026-10-28T08:02:00.000Z') }))

    const response = await POST(new Request('http://local', { method: 'POST' }), { params })
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.investigation).toMatchObject({ id: 'case-1', status: 'QUEUED', revision: 1 })
    expect(mocks.taskFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'task-1', projectId: 'project-1', status: { in: ['FAILED', 'CANCELLED'] } }),
    }))
    expect(mocks.investigationCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId: 'project-1', taskId: 'task-1', artifactId: 'artifact-1', artifactSha256: 'a'.repeat(64),
        providerId: 'reamon-jadx', providerVersion: '1.2.3', requestedBy: 'user-1', status: 'QUEUED',
        failureEvidence: expect.objectContaining({
          existingObservationCount: 3,
          failureMessage: 'Provider timed out',
          resultKeys: ['partial', 'detail', 'providerFailure'],
          partialProviderOutput: {
            schemaVersion: 1,
            runToken: 'a'.repeat(36),
            inputArtifactSha256: 'b'.repeat(64),
            observationCount: 4,
            partialCodeUnitCount: 2,
            partialUnits: [{ type: 'function', key: 'fn:entry', label: 'entry', attributes: { address: '0x100', language: 'c' } }],
            partialUnitsTruncated: true,
          },
        }),
      }),
    }))
  })

  test('does not queue successful tasks or tasks outside the active imported artifact', async () => {
    mocks.taskFindFirst.mockResolvedValue(null)

    const response = await POST(new Request('http://local', { method: 'POST' }), { params })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'Only failed analysis runs for the active artifact can be investigated' })
    expect(mocks.investigationCreate).not.toHaveBeenCalled()
  })

  test('returns an existing case without creating a duplicate', async () => {
    mocks.taskFindFirst.mockResolvedValue({ id: 'task-1', artifactId: 'artifact-1', capability: 'decompile', artifact: { sha256: 'b'.repeat(64) } })
    mocks.investigationFindUnique.mockResolvedValue({ id: 'case-1', status: 'QUEUED', revision: 1 })

    const response = await POST(new Request('http://local', { method: 'POST' }), { params })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ investigation: { id: 'case-1', status: 'QUEUED', revision: 1 }, alreadyQueued: true })
    expect(mocks.investigationCreate).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  getActiveWorkspaceImportSelection: vi.fn(),
  taskFindFirst: vi.fn(),
  investigationFindFirst: vi.fn(),
  investigationFindUnique: vi.fn(),
  investigationCreate: vi.fn(),
  codeAttemptFindMany: vi.fn(),
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
    reamonCodeAttempt: { findMany: mocks.codeAttemptFindMany },
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
    mocks.codeAttemptFindMany.mockResolvedValue([])
  })

  test('loads only the case in the authorized project', async () => {
    mocks.investigationFindFirst.mockResolvedValue({ id: 'case-1', status: 'QUEUED' })

    const response = await GET(new Request('http://local'), { params })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ investigation: { id: 'case-1', status: 'QUEUED' }, attempts: [], candidateUnits: [] })
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
            { type: 'function', key: 'fn:entry', label: 'entry', attributes: { address: '0x100', language: 'c', assembly: 'mov eax, edi\nret\n' } },
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
            partialUnits: [{
              type: 'function', key: 'fn:entry', label: 'entry',
              attributes: { address: '0x100', language: 'c', assembly: 'mov eax, edi\nret\n' },
              textEvidence: {
                assembly: {
                  sha256: createHash('sha256').update('mov eax, edi\nret\n', 'utf8').digest('hex'),
                  capturedSha256: createHash('sha256').update('mov eax, edi\nret\n', 'utf8').digest('hex'),
                  originalBytes: Buffer.byteLength('mov eax, edi\nret\n', 'utf8'),
                  capturedBytes: Buffer.byteLength('mov eax, edi\nret\n', 'utf8'),
                  truncated: false,
                  originalHashVerified: false,
                },
              },
            }],
            partialUnitsTruncated: true,
            partialUnitTextEvidenceBytes: Buffer.byteLength('mov eax, edi\nret\n', 'utf8'),
            partialUnitTextEvidenceTruncated: false,
          },
          providerTextEvidence: { schemaVersion: 1, fields: [], capturedBytes: 0, truncated: false },
        }),
      }),
    }))
  })

  test('retains bounded, hash-linked instruction evidence for later investigation', async () => {
    const assembly = 'mov eax, edi\nret\n'
    const output = 'provider returned a partial listing'
    mocks.taskFindFirst.mockResolvedValue({
      id: 'task-1', projectId: 'project-1', artifactId: 'artifact-1', capability: 'disassemble', status: 'FAILED',
      title: 'Disassemble app', progressMessage: 'Stopped at function 2', error: 'Provider timed out',
      result: { assembly, output, ignoredSecretLikeField: 'not selected' },
      startedAt: new Date('2026-10-28T08:00:00.000Z'), completedAt: new Date('2026-10-28T08:01:00.000Z'),
      createdAt: new Date('2026-10-28T07:59:00.000Z'), artifact: { sha256: 'A'.repeat(64) },
      provider: { pluginId: 'reamon-ghidra', version: '1.2.3' },
    })
    mocks.investigationCreate.mockImplementation(async ({ data }) => ({ id: 'case-1', status: data.status, revision: 1 }))

    const response = await POST(new Request('http://local', { method: 'POST' }), { params })
    const failureEvidence = mocks.investigationCreate.mock.calls[0][0].data.failureEvidence

    expect(response.status).toBe(201)
    expect(failureEvidence.providerTextEvidence).toEqual({
      schemaVersion: 1,
      fields: [assembly, output].map((text, index) => ({
        field: index === 0 ? 'assembly' : 'output',
        text,
        sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        capturedSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        originalBytes: Buffer.byteLength(text, 'utf8'),
        capturedBytes: Buffer.byteLength(text, 'utf8'),
        truncated: false,
      })),
      capturedBytes: Buffer.byteLength(assembly, 'utf8') + Buffer.byteLength(output, 'utf8'),
      truncated: false,
    })
    expect(JSON.stringify(failureEvidence.providerTextEvidence)).not.toContain('not selected')
  })

  test('caps captured provider text without discarding the full-output hash', async () => {
    const assembly = 'x'.repeat(25 * 1024)
    mocks.taskFindFirst.mockResolvedValue({
      id: 'task-1', projectId: 'project-1', artifactId: 'artifact-1', capability: 'disassemble', status: 'FAILED',
      title: 'Disassemble app', progressMessage: '', error: 'Provider timed out', result: { assembly },
      startedAt: null, completedAt: null, createdAt: new Date(), artifact: { sha256: 'A'.repeat(64) }, provider: null,
    })
    mocks.investigationCreate.mockImplementation(async ({ data }) => ({ id: 'case-1', status: data.status, revision: 1 }))

    await POST(new Request('http://local', { method: 'POST' }), { params })
    const evidence = mocks.investigationCreate.mock.calls[0][0].data.failureEvidence.providerTextEvidence

    expect(evidence.capturedBytes).toBe(24 * 1024)
    expect(evidence.truncated).toBe(true)
    expect(evidence.fields[0]).toMatchObject({
      field: 'assembly',
      sha256: createHash('sha256').update(assembly, 'utf8').digest('hex'),
      originalBytes: 25 * 1024,
      capturedBytes: 24 * 1024,
      truncated: true,
    })
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

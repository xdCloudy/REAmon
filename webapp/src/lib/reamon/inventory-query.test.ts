/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  importFindMany: vi.fn(),
  artifactFindMany: vi.fn(),
  artifactCount: vi.fn(),
  artifactFindFirst: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    workspaceImport: { findMany: mocks.importFindMany },
    artifact: {
      findMany: mocks.artifactFindMany,
      count: mocks.artifactCount,
      findFirst: mocks.artifactFindFirst,
    },
  },
}))

import { listWorkspaceFiles } from './inventory-query'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.importFindMany.mockResolvedValue([
    { id: 'new-partial', rootName: 'ExampleApp', status: 'UPLOADING', rootTargetId: 'new-root', createdAt: new Date('2026-10-02T12:00:00Z') },
    { id: 'old-complete', rootName: 'ExampleApp', status: 'COMPLETED', rootTargetId: 'old-root', createdAt: new Date('2026-10-02T11:00:00Z') },
    { id: 'other-root', rootName: 'Firmware', status: 'COMPLETED', rootTargetId: 'firmware-root', createdAt: new Date('2026-10-02T10:00:00Z') },
  ])
  mocks.artifactFindMany.mockResolvedValue([
    {
      id: 'artifact-1', name: 'crypto.dll', relativePath: 'bin/crypto.dll', parentPath: 'bin',
      targetId: 'target-1', importId: 'old-complete', sizeBytes: 10, sha256: 'hash-1', extension: 'dll', status: 'IDENTIFIED', profile: { format: 'pe' },
    },
  ])
  mocks.artifactCount.mockResolvedValue(1)
})

describe('workspace inventory queries', () => {
  test('queries the active completed snapshot and returns bounded results', async () => {
    const result = await listWorkspaceFiles('project-1', { search: 'crypto', format: 'PE', kind: 'executables', limit: 25 })

    expect(result).toMatchObject({ total: 1, limit: 25, hasMore: false })
    expect(result.artifacts[0]).toMatchObject({ id: 'artifact-1', relativePath: 'bin/crypto.dll' })
    expect(mocks.artifactFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 26,
      orderBy: [{ relativePath: 'asc' }, { id: 'asc' }],
      where: expect.objectContaining({
        projectId: 'project-1',
        OR: [{ importId: null }, { importId: { in: ['old-complete', 'other-root'] } }],
        AND: expect.arrayContaining([
          expect.objectContaining({
            OR: [
              { relativePath: { contains: 'crypto', mode: 'insensitive' } },
              { name: { contains: 'crypto', mode: 'insensitive' } },
            ],
          }),
          { profile: { path: ['format'], equals: 'pe' } },
          { extension: { in: expect.arrayContaining(['dll', 'exe']) } },
        ]),
      }),
    }))
  })

  test('keeps duplicate content at distinct workspace paths and reports more pages', async () => {
    mocks.artifactFindMany.mockResolvedValue([
      { id: 'one', name: 'foo.dll', relativePath: 'x64/foo.dll', parentPath: 'x64', targetId: null, importId: 'old-complete', sizeBytes: 3, sha256: 'same', extension: 'dll', status: 'DISCOVERED', profile: {} },
      { id: 'two', name: 'foo.dll', relativePath: 'plugins/foo.dll', parentPath: 'plugins', targetId: null, importId: 'old-complete', sizeBytes: 3, sha256: 'same', extension: 'dll', status: 'DISCOVERED', profile: {} },
    ])
    mocks.artifactCount.mockResolvedValue(3)

    const result = await listWorkspaceFiles('project-1', { limit: 1 })

    expect(result.artifacts.map((artifact) => artifact.relativePath)).toEqual(['x64/foo.dll'])
    expect(result.total).toBe(3)
    expect(result.hasMore).toBe(true)
  })

  test('loads logical artifact details without exposing storage paths', async () => {
    mocks.artifactFindFirst.mockResolvedValue({
      id: 'artifact-1', name: 'crypto.dll', originalName: 'crypto.dll', relativePath: 'bin/crypto.dll', parentPath: 'bin',
      targetId: 'target-1', importId: 'old-complete', sizeBytes: 10, sha256: 'hash-1', extension: 'dll', mimeType: 'application/octet-stream', status: 'IDENTIFIED',
      profile: { targetType: 'FILE', format: 'pe', mimeType: 'application/octet-stream', extension: 'dll', architecture: 'x86-64', platform: 'windows', runtimes: [], embeddedArtifacts: [], entropy: null, metadata: {} },
      createdAt: new Date('2026-10-02T12:00:00Z'), updatedAt: new Date('2026-10-02T12:01:00Z'),
      target: { id: 'target-1', name: 'crypto.dll', targetType: 'FILE', parentTargetId: 'old-root', status: 'IDENTIFIED', profile: {} },
      workspaceImport: { id: 'old-complete', rootName: 'ExampleApp', sourceType: 'BROWSER_DIRECTORY', status: 'COMPLETED' },
      tasks: [{ id: 'task-1', title: 'Inspect exports', category: 'static_analysis', status: 'QUEUED', progress: 0, createdAt: new Date('2026-10-02T12:00:00Z'), updatedAt: new Date('2026-10-02T12:00:00Z') }],
      findings: [],
      hypotheses: [],
      evidence: [],
      derivedFrom: [],
    })

    const { getWorkspaceArtifact } = await import('./inventory-query')
    const result = await getWorkspaceArtifact('project-1', 'artifact-1')

    expect(result).toMatchObject({
      id: 'artifact-1',
      relativePath: 'bin/crypto.dll',
      target: { id: 'target-1' },
      workspaceImport: { id: 'old-complete' },
      tasks: [{ id: 'task-1', createdAt: '2026-10-02T12:00:00.000Z' }],
    })
    expect(result).not.toHaveProperty('storagePath')
    expect(mocks.artifactFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'artifact-1', OR: expect.any(Array) }),
    }))
  })
})

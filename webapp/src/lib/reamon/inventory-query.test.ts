/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  importFindMany: vi.fn(),
  artifactFindMany: vi.fn(),
  artifactCount: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    workspaceImport: { findMany: mocks.importFindMany },
    artifact: {
      findMany: mocks.artifactFindMany,
      count: mocks.artifactCount,
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
})

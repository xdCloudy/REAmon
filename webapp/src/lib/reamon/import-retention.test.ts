/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  importFindMany: vi.fn(),
  importFindFirst: vi.fn(),
  artifactDeleteMany: vi.fn(),
  importDelete: vi.fn(),
  targetDeleteMany: vi.fn(),
  activityCreate: vi.fn(),
  transaction: vi.fn(),
  unlink: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    workspaceImport: { findMany: mocks.importFindMany },
    $transaction: mocks.transaction,
  },
}))
vi.mock('node:fs/promises', () => ({ unlink: mocks.unlink }))

import { applyImportRetention, importRetentionDays } from './import-retention'

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'artifact-1', storagePath: 'project-1/import-old/artifact-1', sizeBytes: 10,
    _count: { tasks: 0, findings: 0, evidence: 0, observations: 0, usedAsSource: 0, derivedFrom: 0 },
    ...overrides,
  }
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'import-old', projectId: 'project-1', rootTargetId: 'target-root', completedAt: new Date('2026-01-01T00:00:00Z'), artifacts: [artifact()], ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  mocks.importFindMany.mockResolvedValueOnce([{ id: 'import-latest' }]).mockResolvedValueOnce([candidate()])
  mocks.importFindFirst.mockResolvedValue({ id: 'import-old', rootTargetId: 'target-root', artifacts: [artifact()] })
  mocks.artifactDeleteMany.mockResolvedValue({ count: 1 })
  mocks.importDelete.mockResolvedValue({ id: 'import-old' })
  mocks.targetDeleteMany.mockResolvedValue({ count: 1 })
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
  mocks.unlink.mockResolvedValue(undefined)
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    workspaceImport: { findFirst: mocks.importFindFirst, delete: mocks.importDelete },
    artifact: { deleteMany: mocks.artifactDeleteMany },
    target: { deleteMany: mocks.targetDeleteMany },
    workspaceActivity: { create: mocks.activityCreate },
  }))
})

afterEach(() => vi.unstubAllEnvs())

describe('importRetentionDays', () => {
  test('defaults safely and clamps configured values', () => {
    expect(importRetentionDays()).toBe(90)
    vi.stubEnv('REAMON_IMPORT_RETENTION_DAYS', '3')
    expect(importRetentionDays()).toBe(7)
    vi.stubEnv('REAMON_IMPORT_RETENTION_DAYS', '99999')
    expect(importRetentionDays()).toBe(3650)
    vi.stubEnv('REAMON_IMPORT_RETENTION_DAYS', '0')
    expect(importRetentionDays()).toBe(0)
  })
})

describe('applyImportRetention', () => {
  test('dry-runs old unreferenced snapshots while preserving the newest snapshot', async () => {
    const result = await applyImportRetention({ now: new Date('2026-10-03T00:00:00Z') })

    expect(result).toMatchObject({ dryRun: true, considered: 1, protected: 0, pruned: 0, deletedArtifacts: 0 })
    expect(result.candidates).toEqual([expect.objectContaining({ id: 'import-old', bytes: 10, protectedByReferences: false })])
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  test('deletes database rows first and cleans storage after commit', async () => {
    const result = await applyImportRetention({ now: new Date('2026-10-03T00:00:00Z'), dryRun: false })

    expect(result).toMatchObject({ dryRun: false, pruned: 1, deletedArtifacts: 1, deletedBytes: 10, storageCleanupFailures: 0 })
    expect(mocks.artifactDeleteMany).toHaveBeenCalledWith({ where: { importId: 'import-old' } })
    expect(mocks.importDelete).toHaveBeenCalledWith({ where: { id: 'import-old' } })
    expect(mocks.targetDeleteMany).toHaveBeenCalledWith({ where: { id: 'target-root', projectId: 'project-1' } })
    expect(mocks.unlink).toHaveBeenCalledWith(expect.stringContaining('project-1/import-old/artifact-1'))
  })

  test('protects snapshots referenced by analysis or lineage records', async () => {
    mocks.importFindMany.mockReset()
    mocks.importFindMany.mockResolvedValueOnce([{ id: 'import-latest' }]).mockResolvedValueOnce([candidate({ artifacts: [artifact({ _count: { tasks: 1, findings: 0, evidence: 0, observations: 0, usedAsSource: 0, derivedFrom: 0 } })] })])

    const result = await applyImportRetention({ dryRun: false, now: new Date('2026-10-03T00:00:00Z') })

    expect(result).toMatchObject({ considered: 1, protected: 1, pruned: 0 })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})

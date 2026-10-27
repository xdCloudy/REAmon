/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  importFindMany: vi.fn(),
  importFindFirst: vi.fn(),
  artifactDeleteMany: vi.fn(),
  importDelete: vi.fn(),
  importUpdateMany: vi.fn(),
  targetDeleteMany: vi.fn(),
  activityCreate: vi.fn(),
  cleanupCreateMany: vi.fn(),
  cleanupFindMany: vi.fn(),
  cleanupFindUnique: vi.fn(),
  cleanupCount: vi.fn(),
  cleanupUpdate: vi.fn(),
  cleanupDeleteMany: vi.fn(),
  transaction: vi.fn(),
  unlink: vi.fn(),
  rm: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    workspaceImport: { findMany: mocks.importFindMany, updateMany: mocks.importUpdateMany },
    artifactStorageCleanup: {
      findMany: mocks.cleanupFindMany, findUnique: mocks.cleanupFindUnique,
      count: mocks.cleanupCount, update: mocks.cleanupUpdate, deleteMany: mocks.cleanupDeleteMany,
    },
    $transaction: mocks.transaction,
  },
}))
vi.mock('node:fs/promises', () => ({ unlink: mocks.unlink, rm: mocks.rm }))
vi.mock('./artifact-storage', () => ({
  resolveArtifactStoragePath: (value: string) => `/artifacts/${value}`,
  removeStagedImport: (projectId: string, importId: string) => mocks.rm(`/artifacts/.uploads/${projectId}/${importId}`, { recursive: true, force: true }),
}))

import { applyImportRetention, importRetentionDays, importStagingRetentionDays } from './import-retention'

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
  mocks.importFindMany.mockResolvedValueOnce([{ id: 'import-latest' }]).mockResolvedValueOnce([candidate()]).mockResolvedValueOnce([])
  mocks.importFindFirst.mockResolvedValue({ id: 'import-old', rootTargetId: 'target-root', artifacts: [artifact()] })
  mocks.artifactDeleteMany.mockResolvedValue({ count: 1 })
  mocks.importDelete.mockResolvedValue({ id: 'import-old' })
  mocks.importUpdateMany.mockResolvedValue({ count: 0 })
  mocks.targetDeleteMany.mockResolvedValue({ count: 1 })
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
  mocks.cleanupCreateMany.mockResolvedValue({ count: 1 })
  mocks.cleanupFindMany.mockResolvedValue([])
  mocks.cleanupFindUnique.mockResolvedValue({ id: 'cleanup-1', storagePath: 'project-1/import-old/artifact-1' })
  mocks.cleanupCount.mockResolvedValue(0)
  mocks.cleanupUpdate.mockResolvedValue({ id: 'cleanup-1' })
  mocks.cleanupDeleteMany.mockResolvedValue({ count: 1 })
  mocks.unlink.mockResolvedValue(undefined)
  mocks.rm.mockResolvedValue(undefined)
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    workspaceImport: { findFirst: mocks.importFindFirst, delete: mocks.importDelete },
    artifact: { deleteMany: mocks.artifactDeleteMany },
    artifactStorageCleanup: { createMany: mocks.cleanupCreateMany },
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

  test('defaults and clamps the incomplete staging retention window', () => {
    expect(importStagingRetentionDays()).toBe(30)
    vi.stubEnv('REAMON_IMPORT_STAGING_RETENTION_DAYS', '2')
    expect(importStagingRetentionDays()).toBe(7)
    vi.stubEnv('REAMON_IMPORT_STAGING_RETENTION_DAYS', '99999')
    expect(importStagingRetentionDays()).toBe(365)
    vi.stubEnv('REAMON_IMPORT_STAGING_RETENTION_DAYS', '0')
    expect(importStagingRetentionDays()).toBe(0)
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
    expect(mocks.cleanupCreateMany).toHaveBeenCalledWith({
      data: [{ storagePath: 'project-1/import-old/artifact-1', sizeBytes: 10 }], skipDuplicates: true,
    })
    expect(mocks.importDelete).toHaveBeenCalledWith({ where: { id: 'import-old' } })
    expect(mocks.targetDeleteMany).toHaveBeenCalledWith({ where: { id: 'target-root', projectId: 'project-1' } })
    expect(mocks.unlink).toHaveBeenCalledWith(expect.stringContaining('project-1/import-old/artifact-1'))
    expect(mocks.cleanupDeleteMany).toHaveBeenCalledWith({ where: { id: 'cleanup-1' } })
  })

  test('retains a durable cleanup row after unlink failure and retries it next run', async () => {
    mocks.unlink.mockRejectedValueOnce(Object.assign(new Error('volume busy'), { code: 'EBUSY' }))
    const failed = await applyImportRetention({ now: new Date('2026-10-03T00:00:00Z'), dryRun: false })
    expect(failed).toMatchObject({ storageCleanupFailures: 1 })
    expect(mocks.cleanupUpdate).toHaveBeenCalledWith({
      where: { id: 'cleanup-1' },
      data: { attempts: { increment: 1 }, lastError: expect.stringContaining('volume busy') },
    })

    mocks.importFindMany.mockReset()
    mocks.importFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    mocks.cleanupFindMany.mockResolvedValueOnce([{ id: 'cleanup-pending', storagePath: 'project-1/import-old/artifact-1' }])
    mocks.cleanupCount.mockResolvedValueOnce(0)
    const retried = await applyImportRetention({ now: new Date('2026-10-04T00:00:00Z'), dryRun: false })
    expect(retried.storageCleanupFailures).toBe(0)
    expect(mocks.unlink).toHaveBeenCalledTimes(2)
    expect(mocks.cleanupDeleteMany).toHaveBeenCalledWith({ where: { id: 'cleanup-pending' } })
  })

  test('protects snapshots referenced by analysis or lineage records', async () => {
    mocks.importFindMany.mockReset()
    mocks.importFindMany.mockResolvedValueOnce([{ id: 'import-latest' }]).mockResolvedValueOnce([candidate({ artifacts: [artifact({ _count: { tasks: 1, findings: 0, evidence: 0, observations: 0, usedAsSource: 0, derivedFrom: 0 } })] })]).mockResolvedValueOnce([])

    const result = await applyImportRetention({ dryRun: false, now: new Date('2026-10-03T00:00:00Z') })

    expect(result).toMatchObject({ considered: 1, protected: 1, pruned: 0 })
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  test('dry-runs stale incomplete imports without touching their staged files', async () => {
    mocks.importFindMany.mockReset()
    mocks.importFindMany
      .mockResolvedValueOnce([{ id: 'import-latest' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'import-stale', projectId: 'project-1', updatedAt: new Date('2026-08-01T00:00:00Z') }])

    const result = await applyImportRetention({ now: new Date('2026-10-03T00:00:00Z') })

    expect(result).toMatchObject({ dryRun: true, stagingRetentionDays: 30, stagingConsidered: 1, stagingCancelled: 0 })
    expect(mocks.importUpdateMany).not.toHaveBeenCalled()
    expect(mocks.rm).not.toHaveBeenCalled()
  })

  test('cancels expired imports conditionally before removing their confined staging directory', async () => {
    mocks.importFindMany.mockReset()
    mocks.importFindMany
      .mockResolvedValueOnce([{ id: 'import-latest' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'import-stale', projectId: 'project-1', updatedAt: new Date('2026-08-01T00:00:00Z') }])
    mocks.importUpdateMany.mockResolvedValueOnce({ count: 1 })

    const result = await applyImportRetention({ dryRun: false, now: new Date('2026-10-03T00:00:00Z') })

    expect(result).toMatchObject({ dryRun: false, stagingConsidered: 1, stagingCancelled: 1, stagingCleanupFailures: 0 })
    expect(mocks.importUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'import-stale', projectId: 'project-1', updatedAt: { lt: expect.any(Date) } }),
      data: expect.objectContaining({ status: 'CANCELLED' }),
    }))
    expect(mocks.rm).toHaveBeenCalledWith('/artifacts/.uploads/project-1/import-stale', { recursive: true, force: true })
  })

  test('does not clean a staging directory when a concurrent chunk refreshed its import row', async () => {
    mocks.importFindMany.mockReset()
    mocks.importFindMany
      .mockResolvedValueOnce([{ id: 'import-latest' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'import-active', projectId: 'project-1', updatedAt: new Date('2026-08-01T00:00:00Z') }])
    mocks.importUpdateMany.mockResolvedValueOnce({ count: 0 })

    const result = await applyImportRetention({ dryRun: false, now: new Date('2026-10-03T00:00:00Z') })

    expect(result).toMatchObject({ stagingConsidered: 1, stagingCancelled: 0 })
    expect(mocks.rm).not.toHaveBeenCalled()
  })
})

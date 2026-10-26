/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import path from 'node:path'
const mocks = vi.hoisted(() => ({ statfs: vi.fn(), rm: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  statfs: mocks.statfs,
  rm: mocks.rm,
}))

import { getArtifactVolumeCapacity, InvalidArtifactStoragePathError, removeStagedImport, resolveArtifactStoragePath, resolveStagedImportDirectory } from './artifact-storage'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rm.mockResolvedValue(undefined)
})

describe('REAmon artifact storage boundary', () => {
  test('resolves a stored key inside the configured root', () => {
    vi.stubEnv('REAMON_ARTIFACTS_PATH', '/data/reamon-artifacts')
    expect(resolveArtifactStoragePath('project-1/import-1/artifact-1')).toBe(path.resolve('/data/reamon-artifacts', 'project-1/import-1/artifact-1'))
    vi.unstubAllEnvs()
  })

  test.each(['../outside', '../../etc/passwd', '/etc/passwd', '', 'artifact\u0000path'])('rejects an escaped storage key: %s', (value) => {
    expect(() => resolveArtifactStoragePath(value)).toThrow(InvalidArtifactStoragePathError)
  })

  test('resolves import staging beneath the uploads directory', () => {
    vi.stubEnv('REAMON_ARTIFACTS_PATH', '/data/reamon-artifacts')
    expect(resolveStagedImportDirectory('project-1', 'import-1')).toBe(
      path.resolve('/data/reamon-artifacts', '.uploads', 'project-1', 'import-1'),
    )
    vi.unstubAllEnvs()
  })

  test.each([
    ['../outside', 'import-1'],
    ['project-1', '../../outside'],
    ['', 'import-1'],
    ['project-1', 'import\u0000bad'],
  ])('rejects escaped staging identifiers (%s, %s)', (projectId, importId) => {
    expect(() => resolveStagedImportDirectory(projectId, importId)).toThrow(InvalidArtifactStoragePathError)
  })

  test('removes only the validated import staging directory', async () => {
    vi.stubEnv('REAMON_ARTIFACTS_PATH', '/data/reamon-artifacts')

    await removeStagedImport('project-1', 'import-1')

    expect(mocks.rm).toHaveBeenCalledWith(
      path.resolve('/data/reamon-artifacts', '.uploads', 'project-1', 'import-1'),
      { recursive: true, force: true },
    )
    vi.unstubAllEnvs()
  })

  test('reports shared filesystem capacity from statfs without walking stored artifacts', async () => {
    vi.stubEnv('REAMON_ARTIFACTS_PATH', '/data/reamon-artifacts')
    mocks.statfs.mockResolvedValueOnce({ blocks: 100n, bsize: 4096n, bavail: 25n })

    const result = await getArtifactVolumeCapacity()

    expect(result).toMatchObject({
      available: true,
      totalBytes: '409600',
      usedBytes: '307200',
      freeBytes: '102400',
      usedPercent: 75,
    })
    expect(mocks.statfs).toHaveBeenCalledWith(path.resolve('/data/reamon-artifacts'), { bigint: true })
    vi.unstubAllEnvs()
  })

  test('returns an unavailable advisory when filesystem capacity cannot be read', async () => {
    mocks.statfs.mockRejectedValueOnce(new Error('filesystem unavailable'))

    await expect(getArtifactVolumeCapacity()).resolves.toMatchObject({
      available: false, totalBytes: null, usedBytes: null, freeBytes: null, usedPercent: null,
    })
  })
})

import { describe, expect, test, vi } from 'vitest'
import path from 'node:path'
import { InvalidArtifactStoragePathError, resolveArtifactStoragePath } from './artifact-storage'

describe('REAmon artifact storage boundary', () => {
  test('resolves a stored key inside the configured root', () => {
    vi.stubEnv('REAMON_ARTIFACTS_PATH', '/data/reamon-artifacts')
    expect(resolveArtifactStoragePath('project-1/import-1/artifact-1')).toBe(path.resolve('/data/reamon-artifacts', 'project-1/import-1/artifact-1'))
    vi.unstubAllEnvs()
  })

  test.each(['../outside', '../../etc/passwd', '/etc/passwd', '', 'artifact\u0000path'])('rejects an escaped storage key: %s', (value) => {
    expect(() => resolveArtifactStoragePath(value)).toThrow(InvalidArtifactStoragePathError)
  })
})

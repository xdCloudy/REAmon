/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { removeStagedImport } from './artifact-storage'

let artifactsRoot = ''

beforeEach(async () => {
  artifactsRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-staging-cleanup-'))
  vi.stubEnv('REAMON_ARTIFACTS_PATH', artifactsRoot)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  if (artifactsRoot) await rm(artifactsRoot, { recursive: true, force: true })
})

describe('staged import cleanup on the filesystem', () => {
  test('removes only the cancelled import bytes', async () => {
    const cancelledDirectory = path.join(artifactsRoot, '.uploads', 'project-1', 'import-cancelled')
    const activeDirectory = path.join(artifactsRoot, '.uploads', 'project-1', 'import-active')
    await mkdir(cancelledDirectory, { recursive: true })
    await mkdir(activeDirectory, { recursive: true })
    await writeFile(path.join(cancelledDirectory, 'large-artifact.part'), Buffer.alloc(1024 * 1024, 0x5a))
    await writeFile(path.join(activeDirectory, 'active-artifact.part'), 'keep')

    await removeStagedImport('project-1', 'import-cancelled')

    await expect(stat(cancelledDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(activeDirectory, 'active-artifact.part'), 'utf8')).resolves.toBe('keep')
  })
})

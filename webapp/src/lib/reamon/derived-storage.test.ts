import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { removeDerivedArtifactProject, resolveDerivedArtifactPath } from './derived-storage'

let root = ''
afterEach(async () => {
  vi.unstubAllEnvs()
  if (root) await rm(root, { recursive: true, force: true })
})

describe('REAmon derived-source storage', () => {
  test('keeps resolved files inside the dedicated derived root', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'reamon-derived-storage-'))
    vi.stubEnv('REAMON_DERIVED_PATH', root)
    expect(resolveDerivedArtifactPath('project-1/artifact-1/source.java')).toBe(path.join(root, 'project-1/artifact-1/source.java'))
    expect(() => resolveDerivedArtifactPath('../outside.txt')).toThrow('Invalid derived artifact path')
  })

  test('removes only the selected project output', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'reamon-derived-storage-'))
    vi.stubEnv('REAMON_DERIVED_PATH', root)
    const file = resolveDerivedArtifactPath('project-1/artifact-1/source.java')
    const sibling = resolveDerivedArtifactPath('project-2/artifact-2/source.java')
    await mkdir(path.dirname(file), { recursive: true })
    await mkdir(path.dirname(sibling), { recursive: true })
    await writeFile(file, 'class A {}')
    await writeFile(sibling, 'class B {}')

    await removeDerivedArtifactProject('project-1')

    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(sibling, 'utf8')).resolves.toBe('class B {}')
  })
})

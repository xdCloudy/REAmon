/** @vitest-environment node */
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

  test('removes pycdc outputs stored under the isolated analyzer-owned root', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'reamon-derived-storage-'))
    vi.stubEnv('REAMON_DERIVED_PATH', root)
    const source = resolveDerivedArtifactPath('project-1/artifact-1/source.py')
    const pycdcOutput = resolveDerivedArtifactPath('.reamon-pycdc-output/project-1/artifact-1/task-1/run-1/pycdc/source.py')
    const siblingOutput = resolveDerivedArtifactPath('.reamon-pycdc-output/project-2/artifact-2/task-2/run-2/pycdc/source.py')
    await mkdir(path.dirname(source), { recursive: true })
    await mkdir(path.dirname(pycdcOutput), { recursive: true })
    await mkdir(path.dirname(siblingOutput), { recursive: true })
    await writeFile(source, 'source')
    await writeFile(pycdcOutput, 'recovered')
    await writeFile(siblingOutput, 'other project')

    await removeDerivedArtifactProject('project-1')

    await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(pycdcOutput)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(siblingOutput, 'utf8')).resolves.toBe('other project')
  })
})

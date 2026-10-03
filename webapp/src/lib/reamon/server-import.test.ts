/**
 * Filesystem-boundary coverage for server-mounted workspace imports.
 *
 * @vitest-environment node
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { inventoryServerSource, readServerSourceArtifact, ServerSourceError } from './server-import'

let sourceRoot = ''

afterEach(async () => {
  vi.unstubAllEnvs()
  if (sourceRoot) await rm(sourceRoot, { recursive: true, force: true })
})

describe('server-mounted workspace imports', () => {
  test('inventories regular files in deterministic logical-path order', async () => {
    sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-server-import-'))
    await mkdir(path.join(sourceRoot, 'nested'), { recursive: true })
    await writeFile(path.join(sourceRoot, 'nested', 'b.bin'), '1234')
    await writeFile(path.join(sourceRoot, 'a.txt'), '12')
    vi.stubEnv('REAMON_SERVER_SOURCE_ROOTS', sourceRoot)

    const inventory = await inventoryServerSource(sourceRoot)

    expect(inventory.entries.map((entry) => entry.relativePath)).toEqual(['a.txt', 'nested/b.bin'])
    expect(inventory.entries.map((entry) => entry.size)).toEqual([2, 4])
    expect(inventory.totalBytes).toBe(6)
    expect(inventory.sourcePath).toBe(sourceRoot)
  })

  test('rejects a source outside the configured roots', async () => {
    sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-server-import-'))
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-server-outside-'))
    await writeFile(path.join(outsideRoot, 'secret.txt'), 'secret')
    vi.stubEnv('REAMON_SERVER_SOURCE_ROOTS', sourceRoot)

    await expect(inventoryServerSource(outsideRoot)).rejects.toMatchObject<Partial<ServerSourceError>>({
      code: 'INVALID_PATH',
      status: 400,
    })
    await rm(outsideRoot, { recursive: true, force: true })
  })

  test('rejects symbolic links during inventory and artifact reads', async () => {
    sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-server-import-'))
    await writeFile(path.join(sourceRoot, 'real.txt'), 'real')
    await symlink('real.txt', path.join(sourceRoot, 'link.txt'))
    vi.stubEnv('REAMON_SERVER_SOURCE_ROOTS', sourceRoot)

    await expect(inventoryServerSource(sourceRoot)).rejects.toMatchObject({ code: 'SYMLINK' })
    await expect(readServerSourceArtifact(sourceRoot, 'link.txt')).rejects.toMatchObject({ code: 'SYMLINK' })
  })

  test('rejects a symbolic link used as the requested source directory', async () => {
    sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-server-import-'))
    const sourceAlias = path.join(sourceRoot, 'alias')
    const realSource = path.join(sourceRoot, 'real-source')
    await mkdir(realSource)
    await writeFile(path.join(realSource, 'app.bin'), 'bytes')
    await symlink(realSource, sourceAlias)
    vi.stubEnv('REAMON_SERVER_SOURCE_ROOTS', sourceRoot)

    await expect(inventoryServerSource(sourceAlias)).rejects.toMatchObject({ code: 'SYMLINK' })
  })

  test('reads only a manifest-sized regular file beneath the source root', async () => {
    sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'reamon-server-import-'))
    await mkdir(path.join(sourceRoot, 'bin'))
    await writeFile(path.join(sourceRoot, 'bin', 'app.bin'), 'bytes')
    vi.stubEnv('REAMON_SERVER_SOURCE_ROOTS', sourceRoot)

    await expect(readServerSourceArtifact(sourceRoot, 'bin/app.bin', 5)).resolves.toEqual(new Uint8Array(Buffer.from('bytes')))
    await expect(readServerSourceArtifact(sourceRoot, '../outside', 0)).rejects.toThrow(/traversal|control/i)
  })
})

/** @vitest-environment node */
import { existsSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { executeElfDependencyInspection, parseElfDependencies } from './elf-dependencies'

const readelfAvailable = existsSync('/usr/bin/readelf') || existsSync('/bin/readelf')

describe('REAmon ELF dependency inspector', () => {
  test('parses dynamic libraries, search paths, and versioned symbol direction', () => {
    const dynamic = [
      'Dynamic section at offset 0x1000 contains 4 entries:',
      ' 0x0000000000000001 (NEEDED) Shared library: [libc.so.6]',
      ' 0x000000000000000e (SONAME) Library soname: [libsample.so]',
      ' 0x000000000000000f (RPATH) Library rpath: [/opt/reamon/lib]',
      ' 0x000000000000001d (RUNPATH) Library runpath: [$ORIGIN/lib]',
    ].join('\n')
    const symbols = [
      "Symbol table '.dynsym' contains 3 entries:",
      '   Num: Value Size Type Bind Vis Ndx Name',
      '     1: 0000000000000000 0 FUNC GLOBAL DEFAULT UND puts@GLIBC_2.2.5 (2)',
      '     2: 0000000000000000 16 FUNC GLOBAL DEFAULT 12 exported@@LIB_1',
      '     3: 0000000000000000 0 FUNC WEAK DEFAULT UND optional',
    ].join('\n')
    const parsed = parseElfDependencies(dynamic, symbols)

    expect(parsed).toEqual({
      needed: ['libc.so.6'],
      soname: 'libsample.so',
      rpath: ['/opt/reamon/lib'],
      runpath: ['$ORIGIN/lib'],
      importedSymbols: [
        { name: 'puts', version: 'GLIBC_2.2.5', direction: 'import' },
        { name: 'optional', version: null, direction: 'import' },
      ],
      exportedSymbols: [{ name: 'exported', version: 'LIB_1', direction: 'export' }],
      truncated: false,
    })
  })

  test('reports when the bounded symbol index omits additional symbols', () => {
    const symbolOutput = Array.from({ length: 81 }, (_, index) =>
      ' ' + (index + 1) + ': 0000000000000000 0 FUNC GLOBAL DEFAULT UND import_' + index,
    ).join('\n')

    const parsed = parseElfDependencies('', symbolOutput)

    expect(parsed.importedSymbols).toHaveLength(80)
    expect(parsed.truncated).toBe(true)
  })

  test.skipIf(!readelfAvailable)('runs readelf on a controlled ELF binary and emits graph observations', async () => {
    const result = await executeElfDependencyInspection({
      targetProfile: { targetType: 'FILE', format: 'elf', mimeType: 'application/x-executable', extension: '', architecture: 'x86_64', platform: 'unix-like', runtimes: ['native'], embeddedArtifacts: [], entropy: null, metadata: {} },
      artifactId: 'artifact-1',
      artifactPath: process.execPath,
    })

    expect(result).toMatchObject({ status: 'completed', toolId: 'reamon-elf-dependencies' })
    expect(result.data).toMatchObject({
      neededLibraries: expect.any(Array),
      importedSymbols: expect.any(Array),
      observations: expect.arrayContaining([
        expect.objectContaining({ kind: 'entity', type: 'binary' }),
        expect.objectContaining({ kind: 'relationship', type: 'depends_on' }),
      ]),
    })
  })

  test('fails closed when no controlled artifact path is provided', async () => {
    const result = await executeElfDependencyInspection({
      targetProfile: { targetType: 'FILE', format: 'elf', mimeType: 'application/x-executable', extension: '', architecture: null, platform: null, runtimes: [], embeddedArtifacts: [], entropy: null, metadata: {} },
    })

    expect(result).toMatchObject({ status: 'failed', error: 'Controlled artifact path is required' })
  })
})

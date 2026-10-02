/** @vitest-environment node */
import { existsSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { executeElfInspection, parseReadelfHeader } from './elf-inspector'

const readelfAvailable = existsSync('/usr/bin/readelf') || existsSync('/bin/readelf')

describe('REAmon ELF process inspector', () => {
  test('parses bounded readelf header fields into typed metadata', () => {
    const header = parseReadelfHeader(`ELF Header:
  Class:                             ELF64
  Data:                              2's complement, little endian
  OS/ABI:                            UNIX - System V
  ABI Version:                       0
  Type:                              DYN (Position-Independent Executable file)
  Machine:                           Advanced Micro Devices X86-64
  Entry point address:               0x27e0
  Number of program headers:         14
  Number of section headers:         30
`)

    expect(header).toEqual({
      class: 'ELF64',
      data: "2's complement, little endian",
      osAbi: 'UNIX - System V',
      abiVersion: 0,
      type: 'DYN',
      machine: 'Advanced Micro Devices X86-64',
      entryPoint: '0x27e0',
      programHeaderCount: 14,
      sectionHeaderCount: 30,
    })
  })

  test.skipIf(!readelfAvailable)('runs readelf against a controlled ELF artifact and emits an observation', async () => {
    const result = await executeElfInspection({
      targetProfile: { targetType: 'FILE', format: 'elf', mimeType: 'application/x-executable', extension: 'so', architecture: 'x86_64', platform: 'unix-like', runtimes: ['native-library'], embeddedArtifacts: [], entropy: null, metadata: {} },
      artifactId: 'artifact-1',
      artifactPath: process.execPath,
    })

    expect(result).toMatchObject({ status: 'completed', toolId: 'reamon-elf-inspector' })
    expect(result.data).toMatchObject({
      header: { class: expect.stringMatching(/^ELF/), machine: expect.any(String) },
      observations: [{ kind: 'entity', type: 'elf_header', key: 'artifact:artifact-1:elf-header' }],
    })
  })

  test('fails closed when no controlled artifact path is provided', async () => {
    const result = await executeElfInspection({
      targetProfile: { targetType: 'FILE', format: 'elf', mimeType: 'application/x-executable', extension: '', architecture: null, platform: null, runtimes: [], embeddedArtifacts: [], entropy: null, metadata: {} },
    })

    expect(result).toMatchObject({ status: 'failed', error: 'Controlled artifact path is required' })
  })
})

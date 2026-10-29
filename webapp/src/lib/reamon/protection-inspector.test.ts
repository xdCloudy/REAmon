/** @vitest-environment node */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { assessElfProtection, assessPeProtection, executeProtectionInspection, elfProtectionObservation, elfSectionObservations, peSectionObservations, protectionObservation } from './protection-inspector'

function highEntropySample(size = 1024): Buffer {
  return Buffer.from(Array.from({ length: size }, (_, index) => index % 256))
}

function peFixture(sectionNames: string[], payloads: Array<Buffer | null> = []): Buffer {
  const peOffset = 0x80
  const optionalHeaderSize = 0xE0
  const sectionTable = peOffset + 24 + optionalHeaderSize
  const sectionDataOffset = 0x400
  const payloadSize = payloads.reduce((size, payload) => size + (payload?.length || 0), 0)
  const bytes = Buffer.alloc(Math.max(sectionTable + sectionNames.length * 40, sectionDataOffset + payloadSize))
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(peOffset, 0x3c)
  bytes.write('PE\0\0', peOffset, 'binary')
  bytes.writeUInt16LE(0x8664, peOffset + 4)
  bytes.writeUInt16LE(sectionNames.length, peOffset + 6)
  bytes.writeUInt16LE(optionalHeaderSize, peOffset + 20)
  bytes.writeUInt32LE(0x1000, peOffset + 24 + 16)
  bytes.writeUInt16LE(0x20b, peOffset + 24)
  bytes.writeUInt32LE(16, peOffset + 24 + 108)
  bytes.writeUInt32LE(0x3000, peOffset + 24 + 112 + 8)
  bytes.writeUInt32LE(0x80, peOffset + 24 + 112 + 12)
  bytes.writeUInt32LE(0x500, peOffset + 24 + 112 + 32)
  bytes.writeUInt32LE(0x80, peOffset + 24 + 112 + 36)
  let nextPayloadOffset = sectionDataOffset
  sectionNames.forEach((name, index) => {
    const offset = sectionTable + index * 40
    const payload = payloads[index]
    bytes.write(name.slice(0, 8), offset, 'ascii')
    bytes.writeUInt32LE(payload?.length || 0x1000, offset + 8)
    bytes.writeUInt32LE(name === 'UPX0' ? 0x2000 : name === 'UPX1' ? 0x1000 : 0x1000 + index * 0x1000, offset + 12)
    bytes.writeUInt32LE(payload?.length || 0, offset + 16)
    bytes.writeUInt32LE(payload ? nextPayloadOffset : 0, offset + 20)
    bytes.writeUInt32LE(name === '.text' || name === 'UPX1' ? 0x60000020 : 0x40000040, offset + 36)
    if (payload) {
      payload.copy(bytes, nextPayloadOffset)
      nextPayloadOffset += payload.length
    }
  })
  return bytes
}

describe('static PE protection evidence', () => {
  test('reports UPX section markers as a suspected family, not confirmed protection', () => {
    const result = assessPeProtection(peFixture(['UPX0', 'UPX1']))
    expect(result).toMatchObject({
      status: 'suspected', family: 'UPX', inspectedBytes: 1024, architecture: 'x86_64', entryPointRva: 0x1000,
      entryPointSection: 'UPX1',
      importDirectory: { rva: 0x3000, size: 0x80 },
      certificateTable: { fileOffset: 0x500, size: 0x80 },
      scope: expect.stringContaining('no execution'), sampledBytes: 0,
      sections: [
        expect.objectContaining({ index: 0, name: 'UPX0', executable: false, sampledBytes: 0, entropyBits: null }),
        expect.objectContaining({ index: 1, name: 'UPX1', executable: true, code: true, sampledBytes: 0, entropyBits: null }),
      ],
    })
    expect(result.evidence).toHaveLength(2)
    expect(protectionObservation(result, 'artifact-a')).toMatchObject({
      type: 'protection_assessment',
      key: 'artifact:artifact-a:protection-static-v1',
      attributes: {
        assessment: 'suspected', family: 'UPX', confirmed: false, architecture: 'x86_64',
        entryPointSection: 'UPX1', importDirectoryRva: 0x3000, importDirectorySize: 0x80,
        certificateTableOffset: 0x500, certificateTableSize: 0x80,
      },
    })
  })

  test('does not classify an ordinary PE or malformed header as unprotected', () => {
    expect(assessPeProtection(peFixture(['.text', '.rdata']))).toMatchObject({ status: 'unknown', family: null })
    expect(assessPeProtection(Buffer.from('MZ'))).toMatchObject({ status: 'unknown', family: null })
  })

  test('records an entry point that is unmapped or mapped to non-executable data', () => {
    const unmapped = peFixture(['.text'])
    unmapped.writeUInt32LE(0x9000, 0x80 + 24 + 16)
    expect(assessPeProtection(unmapped)).toMatchObject({ status: 'suspected', entryPointSection: null })
    expect(assessPeProtection(unmapped).evidence.join(' ')).toContain('did not map to a declared section')

    const nonExecutable = assessPeProtection(peFixture(['.rdata']))
    expect(nonExecutable).toMatchObject({ status: 'suspected', family: null, entryPointSection: '.rdata' })
    expect(nonExecutable.evidence.join(' ')).toContain('maps to non-executable section')
  })

  test('records executable-section entropy only as a generic suspicion', () => {
    const result = assessPeProtection(peFixture(['.text']), new Map([[0, highEntropySample()]]))
    expect(result).toMatchObject({ status: 'suspected', family: null, sampledBytes: 1024 })
    expect(result.sections[0]).toMatchObject({ sampledBytes: 1024, entropyBits: 8 })
    expect(result.evidence.join(' ')).toContain('does not identify a protection family')
    expect(protectionObservation(result, 'artifact-a').label).toBe('Protection indicator observed; family unknown')
    expect(assessPeProtection(peFixture(['.text']), new Map([[0, Buffer.alloc(1024, 0x41)]])))
      .toMatchObject({ status: 'unknown', family: null, sampledBytes: 1024 })
  })

  test('keeps assessments and PE region evidence distinct across analysis runs', () => {
    const assessment = assessPeProtection(peFixture(['.text']))
    const first = [
      protectionObservation(assessment, 'artifact-a', 'task-a'),
      ...peSectionObservations(assessment.sections, 'artifact-a', 'task-a'),
    ]
    const second = [
      protectionObservation(assessment, 'artifact-a', 'task-b'),
      ...peSectionObservations(assessment.sections, 'artifact-a', 'task-b'),
    ]

    expect(first.map((observation) => observation.key)).not.toEqual(second.map((observation) => observation.key))
    expect(first[0].key).toBe('artifact:artifact-a:protection-static-v1:task:task-a')
    expect(second[0].key).toBe('artifact:artifact-a:protection-static-v1:task:task-b')
    expect(protectionObservation(assessment, 'artifact-a').key).toBe('artifact:artifact-a:protection-static-v1')
  })

  test('inspects a stored file through the plugin without executing it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reamon-protection-'))
    const filePath = path.join(root, 'fixture.exe')
    await writeFile(filePath, peFixture(['UPX0', 'UPX1'], [null, highEntropySample()]))
    try {
      const result = await executeProtectionInspection({
        targetProfile: { targetType: 'FILE', format: 'pe', mimeType: 'application/x-executable', extension: 'exe', architecture: 'x86-64', platform: 'windows', runtimes: ['native'], embeddedArtifacts: [], entropy: null, metadata: {} },
        artifactId: 'artifact-a', artifactPath: filePath,
      })
      expect(result).toMatchObject({ status: 'completed', toolId: 'reamon-protection-inspector', data: { assessment: { status: 'suspected', family: 'UPX', sampledBytes: 1024 } } })
      expect(result.data.observations).toHaveLength(3)
      expect(result.data.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'pe_section_region', key: 'artifact:artifact-a:pe-section:1', attributes: expect.objectContaining({ executable: true, sampledBytes: 1024, entropyBits: 8 }) }),
      ]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('caps section sampling per section and across the whole artifact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reamon-protection-bounds-'))
    const filePath = path.join(root, 'large-sections.exe')
    const oversizedSample = highEntropySample(128 * 1024)
    await writeFile(filePath, peFixture(['.text', '.text', '.text', '.text'], Array(4).fill(oversizedSample)))
    try {
      const result = await executeProtectionInspection({
        targetProfile: { targetType: 'FILE', format: 'pe', mimeType: 'application/x-executable', extension: 'exe', architecture: 'x86-64', platform: 'windows', runtimes: ['native'], embeddedArtifacts: [], entropy: null, metadata: {} },
        artifactId: 'artifact-b', artifactPath: filePath,
      })
      const assessment = result.data.assessment as { sampledBytes: number; sections: Array<{ sampledBytes: number }> }
      expect(result.status).toBe('completed')
      expect(assessment.sampledBytes).toBeLessThanOrEqual(256 * 1024)
      expect(assessment.sections.every((section) => section.sampledBytes <= 64 * 1024)).toBe(true)
      expect(assessment.sampledBytes).toBe(256 * 1024)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('marks section data that extends beyond the artifact boundary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reamon-protection-truncated-'))
    const filePath = path.join(root, 'truncated-section.exe')
    const bytes = peFixture(['.text'], [Buffer.alloc(64, 0x90)])
    const sectionTable = 0x80 + 24 + 0xE0
    bytes.writeUInt32LE(128, sectionTable + 16)
    await writeFile(filePath, bytes)
    try {
      const result = await executeProtectionInspection({
        targetProfile: { targetType: 'FILE', format: 'pe', mimeType: 'application/x-executable', extension: 'exe', architecture: 'x86-64', platform: 'windows', runtimes: ['native'], embeddedArtifacts: [], entropy: null, metadata: {} },
        artifactId: 'artifact-truncated', artifactPath: filePath,
      })
      const assessment = result.data.assessment as { status: string; family: string | null; sections: Array<{ rawDataTruncated: boolean }>; evidence: string[] }
      expect(result.status).toBe('completed')
      expect(assessment).toMatchObject({ status: 'suspected', family: null })
      expect(assessment.sections[0].rawDataTruncated).toBe(true)
      expect(assessment.evidence.join(' ')).toContain('section data is truncated')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not sample PE headers misdeclared as executable section data', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reamon-protection-overlap-'))
    const filePath = path.join(root, 'overlapping-section.exe')
    const bytes = peFixture(['.text'], [highEntropySample()])
    const sectionTable = 0x80 + 24 + 0xE0
    bytes.writeUInt32LE(0, sectionTable + 20)
    await writeFile(filePath, bytes)
    try {
      const result = await executeProtectionInspection({
        targetProfile: { targetType: 'FILE', format: 'pe', mimeType: 'application/x-executable', extension: 'exe', architecture: 'x86-64', platform: 'windows', runtimes: ['native'], embeddedArtifacts: [], entropy: null, metadata: {} },
        artifactId: 'artifact-overlap', artifactPath: filePath,
      })
      const assessment = result.data.assessment as { status: string; family: string | null; sampledBytes: number; sections: Array<{ rawDataOverlapsHeaders: boolean }>; evidence: string[] }
      expect(result.status).toBe('completed')
      expect(assessment).toMatchObject({ status: 'suspected', family: null, sampledBytes: 0 })
      expect(assessment.sections[0].rawDataOverlapsHeaders).toBe(true)
      expect(assessment.evidence.join(' ')).toContain('overlapping its headers')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('static ELF protection evidence', () => {
  const header = `ELF Header:
  Class:                             ELF64
  Machine:                           Advanced Micro Devices X86-64
  Entry point address:               0x401000

Program Headers:
  Type           Offset   VirtAddr           PhysAddr           FileSiz  MemSiz   Flg Align
  LOAD           0x000000 0x0000000000400000 0x0000000000400000 0x001000 0x002000 R E 0x1000

Section Headers:
  [ 1] .UPX0             PROGBITS         0000000000401000 001000 001000 00 WAX 0   0  1
`

  test('reports ELF UPX section markers as suspicion and preserves the uncertainty', () => {
    const assessment = assessElfProtection(header, 4096)
    expect(assessment).toMatchObject({ status: 'suspected', family: 'UPX', architecture: 'Advanced Micro Devices X86-64', entryPoint: '0x401000', inspectedBytes: 4096, outputTruncated: false })
    expect(assessment.evidence.join(' ')).toContain('not confirmation of UPX packing')
    expect(elfProtectionObservation(assessment, 'elf-a')).toMatchObject({
      key: 'artifact:elf-a:protection-static-v1',
      attributes: { assessment: 'suspected', family: 'UPX', confirmed: false },
    })
    expect(elfProtectionObservation(assessment, 'elf-a', 'task-a').key).toBe('artifact:elf-a:protection-static-v1:task:task-a')
    expect(elfProtectionObservation(assessment, 'elf-a', 'task-b').key).toBe('artifact:elf-a:protection-static-v1:task:task-b')
  })

  test('does not report protection for ordinary ELF headers without suspicious structures', () => {
    const ordinary = header.replace('  [ 1] .UPX0', '  [ 1] .text')
    expect(assessElfProtection(ordinary, 4096)).toMatchObject({ status: 'unknown', family: null })
  })

  test('records an unmapped entry point as suspicion and keeps truncated output explicit', () => {
    const anomalous = header.replace('0x401000', '0x900000')
    expect(assessElfProtection(anomalous, 4096).evidence.join(' ')).toContain('does not map into a declared executable LOAD segment')
    expect(assessElfProtection('ELF Header:', 4096, true)).toMatchObject({ status: 'unknown', outputTruncated: true })
  })

  test('samples bounded executable ELF sections and reports entropy as an unknown-family hypothesis', () => {
    const executableText = header
      .replace('.UPX0', '.text')
      .replace('001000 001000 00 WAX', '001000 000100 00 AX')
    const sample = Buffer.from(Array.from({ length: 256 }, (_, index) => index))
    const assessment = assessElfProtection(executableText, 4096, false, new Map([[1, sample]]))

    expect(assessment).toMatchObject({ status: 'suspected', family: null, sampledBytes: 256 })
    expect(assessment.sections).toEqual([expect.objectContaining({
      index: 1, name: '.text', type: 'PROGBITS', fileOffset: 0x1000, fileSize: 0x100,
      executable: true, sampledBytes: 256, entropyBits: 8, rawDataTruncated: false,
    })])
    expect(assessment.evidence.join(' ')).toContain('does not identify a protection family')
    expect(elfSectionObservations(assessment.sections, 'elf-a', 'task-a')).toEqual([expect.objectContaining({
      type: 'elf_section_region',
      key: 'artifact:elf-a:elf-section:1:task:task-a',
      attributes: expect.objectContaining({ fileOffset: 0x1000, fileSize: 0x100, entropyBits: 8, executable: true }),
    })])
  })

  test('runs bounded readelf against an ELF artifact without executing the target', async (context) => {
    if (!existsSync('/bin/true') || !existsSync('/usr/bin/readelf')) context.skip()
    const result = await executeProtectionInspection({
      targetProfile: { targetType: 'FILE', format: 'elf', mimeType: 'application/x-executable', extension: '', architecture: 'x86-64', platform: 'linux', runtimes: ['native'], embeddedArtifacts: [], entropy: null, metadata: {} },
      artifactId: 'system-elf-fixture', artifactPath: '/bin/true',
    })
    expect(result).toMatchObject({ status: 'completed', toolId: 'reamon-protection-inspector' })
    expect(result.data.assessment).toMatchObject({ architecture: expect.stringContaining('X86-64'), inspectedBytes: expect.any(Number), outputTruncated: false })
    expect((result.data.assessment as { sampledBytes: number }).sampledBytes).toBeGreaterThan(0)
    expect(result.data.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'protection_assessment', key: 'artifact:system-elf-fixture:protection-static-v1' }),
      expect.objectContaining({ type: 'elf_section_region', key: expect.stringMatching(/^artifact:system-elf-fixture:elf-section:/) }),
    ]))
  })
})

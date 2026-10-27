/** @vitest-environment node */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { assessPeProtection, executeProtectionInspection, protectionObservation } from './protection-inspector'

function peFixture(sectionNames: string[]): Buffer {
  const peOffset = 0x80
  const optionalHeaderSize = 0xE0
  const sectionTable = peOffset + 24 + optionalHeaderSize
  const bytes = Buffer.alloc(sectionTable + sectionNames.length * 40)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(peOffset, 0x3c)
  bytes.write('PE\0\0', peOffset, 'binary')
  bytes.writeUInt16LE(0x8664, peOffset + 4)
  bytes.writeUInt16LE(sectionNames.length, peOffset + 6)
  bytes.writeUInt16LE(optionalHeaderSize, peOffset + 20)
  bytes.writeUInt32LE(0x1000, peOffset + 24 + 16)
  sectionNames.forEach((name, index) => bytes.write(name.slice(0, 8), sectionTable + index * 40, 'ascii'))
  sectionNames.forEach((name, index) => bytes.writeUInt32LE(name === '.text' || name === 'UPX1' ? 0x60000020 : 0x40000040, sectionTable + index * 40 + 36))
  return bytes
}

describe('static PE protection evidence', () => {
  test('reports UPX section markers as a suspected family, not confirmed protection', () => {
    const result = assessPeProtection(peFixture(['UPX0', 'UPX1']))
    expect(result).toMatchObject({
      status: 'suspected', family: 'UPX', inspectedBytes: 456, architecture: 'x86_64', entryPointRva: 0x1000,
      scope: expect.stringContaining('no execution'),
      sections: [
        expect.objectContaining({ index: 0, name: 'UPX0', executable: false }),
        expect.objectContaining({ index: 1, name: 'UPX1', executable: true, code: true }),
      ],
    })
    expect(result.evidence).toHaveLength(2)
    expect(protectionObservation(result, 'artifact-a')).toMatchObject({
      type: 'protection_assessment',
      key: 'artifact:artifact-a:protection-static-v1',
      attributes: { assessment: 'suspected', family: 'UPX', confirmed: false },
    })
  })

  test('does not classify an ordinary PE or malformed header as unprotected', () => {
    expect(assessPeProtection(peFixture(['.text', '.rdata']))).toMatchObject({ status: 'unknown', family: null })
    expect(assessPeProtection(Buffer.from('MZ'))).toMatchObject({ status: 'unknown', family: null })
  })

  test('inspects a stored file through the plugin without executing it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reamon-protection-'))
    const filePath = path.join(root, 'fixture.exe')
    await writeFile(filePath, peFixture(['UPX0', 'UPX1']))
    try {
      const result = await executeProtectionInspection({
        targetProfile: { targetType: 'FILE', format: 'pe', mimeType: 'application/x-executable', extension: 'exe', architecture: 'x86-64', platform: 'windows', runtimes: ['native'], embeddedArtifacts: [], entropy: null, metadata: {} },
        artifactId: 'artifact-a', artifactPath: filePath,
      })
      expect(result).toMatchObject({ status: 'completed', toolId: 'reamon-protection-inspector', data: { assessment: { status: 'suspected', family: 'UPX' } } })
      expect(result.data.observations).toHaveLength(3)
      expect(result.data.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'pe_section_region', key: 'artifact:artifact-a:pe-section:1', attributes: expect.objectContaining({ executable: true }) }),
      ]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/** @vitest-environment node */
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { executeFileInspection, fileObservation } from './file-inspector'

const fileAvailable = existsSync('/usr/bin/file') || existsSync('/bin/file')

describe('REAmon generic file process inspector', () => {
  test('creates a stable metadata fact', () => {
    expect(fileObservation('ELF 64-bit LSB shared object', 'artifact-1')).toEqual({
      observation: {
        kind: 'fact',
        type: 'file_identification',
        key: 'artifact:artifact-1:file-identification',
        label: 'ELF 64-bit LSB shared object',
        attributes: { description: 'ELF 64-bit LSB shared object' },
      },
    })
  })

  test.skipIf(!fileAvailable)('runs file against a controlled artifact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reamon-file-inspector-'))
    const filePath = path.join(root, 'payload.txt')
    await writeFile(filePath, 'a plain text payload\n')
    try {
      const result = await executeFileInspection({
        targetProfile: { targetType: 'FILE', format: 'unknown', mimeType: 'text/plain', extension: 'txt', architecture: null, platform: null, runtimes: [], embeddedArtifacts: [], entropy: null, metadata: {} },
        artifactId: 'artifact-1',
        artifactPath: filePath,
      })

      expect(result).toMatchObject({ status: 'completed', toolId: 'reamon-file-inspector' })
      expect(result.data).toMatchObject({
        description: expect.stringContaining('ASCII text'),
        observations: [{ kind: 'fact', type: 'file_identification', key: 'artifact:artifact-1:file-identification' }],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails closed when no controlled artifact path is provided', async () => {
    const result = await executeFileInspection({
      targetProfile: { targetType: 'UNKNOWN', format: 'unknown', mimeType: 'application/octet-stream', extension: '', architecture: null, platform: null, runtimes: [], embeddedArtifacts: [], entropy: null, metadata: {} },
    })

    expect(result).toMatchObject({ status: 'failed', error: 'Controlled artifact path is required' })
  })
})

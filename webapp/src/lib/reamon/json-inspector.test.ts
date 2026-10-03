/** @vitest-environment node */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { executeJsonInspection } from './json-inspector'

describe('REAmon JSON inspector', () => {
  test('summarizes a bounded JSON document as a stable observation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reamon-json-inspector-'))
    const filePath = path.join(root, 'settings.json')
    await writeFile(filePath, JSON.stringify({ service: { port: 3000 }, enabled: true }))
    try {
      const result = await executeJsonInspection({
        targetProfile: { targetType: 'FILE', format: 'json', mimeType: 'application/json', extension: 'json', architecture: null, platform: null, runtimes: [], embeddedArtifacts: [], entropy: null, metadata: {} },
        artifactId: 'artifact-1',
        artifactPath: filePath,
      })
      expect(result).toMatchObject({ status: 'completed', toolId: 'reamon-json-inspector' })
      expect(result.data).toMatchObject({
        summary: { rootType: 'object', itemCount: 2, topLevelKeys: ['service', 'enabled'] },
        observations: [{ kind: 'entity', type: 'json_document', key: 'artifact:artifact-1:json-document' }],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails closed for malformed JSON and missing controlled paths', async () => {
    const profile = { targetType: 'FILE' as const, format: 'json', mimeType: 'application/json', extension: 'json', architecture: null, platform: null, runtimes: [], embeddedArtifacts: [], entropy: null, metadata: {} }
    const missing = await executeJsonInspection({ targetProfile: profile })
    expect(missing).toMatchObject({ status: 'failed', error: 'Controlled artifact path is required' })

    const root = await mkdtemp(path.join(os.tmpdir(), 'reamon-json-inspector-'))
    const filePath = path.join(root, 'broken.json')
    await writeFile(filePath, '{broken')
    try {
      const result = await executeJsonInspection({ targetProfile: profile, artifactPath: filePath })
      expect(result.status).toBe('failed')
      expect(result.error).toMatch(/JSON|property name/i)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

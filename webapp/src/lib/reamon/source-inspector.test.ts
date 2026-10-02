/** @vitest-environment node */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { executeSourceInspection, extractStrings } from './source-inspector'

describe('REAmon process source inspector', () => {
  test('extracts bounded unique strings into stable observations', () => {
    const result = extractStrings('hello world\nhello world\napi.example.test\nno', 'artifact-1', 10)

    expect(result.strings).toEqual(['hello world', 'api.example.test'])
    expect(result.observations).toMatchObject([
      { kind: 'entity', type: 'string', key: expect.stringMatching(/^artifact:artifact-1:string:/), label: 'hello world' },
      { kind: 'entity', type: 'string', label: 'api.example.test' },
    ])
  })

  test('runs the production strings adapter against a controlled artifact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'reamon-source-inspector-'))
    const filePath = path.join(root, 'source.txt')
    await writeFile(filePath, 'const endpoint = "https://api.example.test/v1"\nconst secret = "not-a-secret"\n')
    try {
      const result = await executeSourceInspection({
        targetProfile: { targetType: 'FILE', format: 'source', mimeType: 'text/plain', extension: 'txt', architecture: null, platform: null, runtimes: [], embeddedArtifacts: [], entropy: null, metadata: {} },
        artifactId: 'artifact-1',
        artifactPath: filePath,
      })

      expect(result).toMatchObject({ status: 'completed', toolId: 'reamon-source-inspector' })
      expect(result.data).toMatchObject({ strings: expect.arrayContaining(['const endpoint = "https://api.example.test/v1"']) })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fails closed when no controlled artifact path is provided', async () => {
    const result = await executeSourceInspection({
      targetProfile: { targetType: 'FILE', format: 'source', mimeType: 'text/plain', extension: 'txt', architecture: null, platform: null, runtimes: [], embeddedArtifacts: [], entropy: null, metadata: {} },
    })

    expect(result).toMatchObject({ status: 'failed', error: 'Controlled artifact path is required' })
  })
})

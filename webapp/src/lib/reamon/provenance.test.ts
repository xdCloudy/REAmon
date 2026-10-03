/** @vitest-environment node */
import { describe, expect, test, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import {
  buildProvenanceKey,
  MAX_PROVENANCE_INPUTS,
  parseProvenanceArtifactIds,
  parseProvenanceTaskId,
  PROVENANCE_RELATION,
  recordArtifactProvenance,
} from './provenance'

describe('derived artifact provenance', () => {
  test('parses a bounded, duplicate-free source list', () => {
    expect(parseProvenanceArtifactIds(JSON.stringify([' source-a ', 'source-b']))).toEqual(['source-a', 'source-b'])
    expect(parseProvenanceTaskId(' task-1 ')).toBe('task-1')
    expect(parseProvenanceArtifactIds(null)).toEqual([])
    expect(parseProvenanceTaskId(null)).toBeNull()
  })

  test.each([
    ['not-json', /valid JSON/],
    [JSON.stringify({ id: 'source-a' }), /must be an array/],
    [JSON.stringify(['source-a', 'source-a']), /duplicates/],
    [JSON.stringify(['']), /non-empty/],
    [JSON.stringify(Array.from({ length: MAX_PROVENANCE_INPUTS + 1 }, (_, index) => `source-${index}`)), /at most/],
  ])('rejects malformed source input: %s', (value, message) => {
    expect(() => parseProvenanceArtifactIds(value)).toThrow(message)
  })

  test('upserts one stable row per source and bounds metadata', async () => {
    const upsert = vi.fn().mockResolvedValue({})
    const tx = { artifactProvenance: { upsert } } as unknown as Prisma.TransactionClient
    const sourceRelativePath = 'nested/'.repeat(200) + 'input.bin'
    const sourceSha256 = 'a'.repeat(256)

    await recordArtifactProvenance(tx, {
      projectId: 'project-1',
      artifactId: 'output-1',
      sourceArtifacts: [
        { id: 'source-a', relativePath: sourceRelativePath, sha256: sourceSha256 },
        { id: 'source-b', relativePath: 'second.bin', sha256: 'b'.repeat(64) },
      ],
      taskId: 'task-1',
    })

    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { provenanceKey: buildProvenanceKey('output-1', 'source-a', 'task-1') },
      create: expect.objectContaining({
        projectId: 'project-1',
        artifactId: 'output-1',
        sourceArtifactId: 'source-a',
        taskId: 'task-1',
        relation: PROVENANCE_RELATION,
        metadata: { sourceRelativePath: sourceRelativePath.slice(0, 512), sourceSha256: 'a'.repeat(128) },
      }),
    }))
  })

  test('rejects an output artifact as its own source', async () => {
    const tx = { artifactProvenance: { upsert: vi.fn() } } as unknown as Prisma.TransactionClient

    await expect(recordArtifactProvenance(tx, {
      projectId: 'project-1',
      artifactId: 'artifact-1',
      sourceArtifacts: [{ id: 'artifact-1', relativePath: 'output.bin', sha256: 'a'.repeat(64) }],
      taskId: null,
    })).rejects.toThrow(/invalid source artifact/)
  })
})

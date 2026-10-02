/** @vitest-environment node */
import { describe, expect, test, vi } from 'vitest'
import { ingestToolResult, parseToolObservations } from './result-ingestion'

describe('parseToolObservations', () => {
  test('accepts typed entities and relationships while rejecting unsafe shapes', () => {
    const result = parseToolObservations({
      observations: [
        { kind: 'entity', type: 'function', key: 'fn:main', label: 'main', attributes: { address: 4096, exported: true, ignored: ['nested'] } },
        { kind: 'relationship', type: 'calls', key: 'call:main->parse', fromKey: 'fn:main', toKey: 'fn:parse', relation: 'calls', attributes: {} },
        { kind: 'relationship', type: 'calls', key: 'broken', fromKey: 'fn:main', attributes: {} },
        { kind: 'entity', type: 'function', key: 'fn:main', attributes: {} },
      ],
    })

    expect(result).toEqual({
      observations: [
        expect.objectContaining({ kind: 'entity', key: 'fn:main', attributes: { address: 4096, exported: true } }),
        expect.objectContaining({ kind: 'relationship', key: 'call:main->parse', fromKey: 'fn:main', toKey: 'fn:parse' }),
      ],
      rejected: 2,
    })
  })

  test('ignores results without an observations array', () => {
    expect(parseToolObservations({ strings: ['hello'] })).toEqual({ observations: [], rejected: 0 })
  })
})

describe('ingestToolResult', () => {
  test('upserts observations using the project, source, and stable key', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'observation-1' })
    const tx = { reamonObservation: { upsert } } as never

    const summary = await ingestToolResult(tx, {
      projectId: 'project-1',
      taskId: 'task-1',
      targetId: 'target-1',
      artifactId: 'artifact-1',
      source: 'reamon-source-inspector',
      data: { observations: [{ kind: 'entity', type: 'function', key: 'fn:main', attributes: {} }] },
    })

    expect(summary).toEqual({ accepted: 1, rejected: 0 })
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId_source_stableKey: { projectId: 'project-1', source: 'reamon-source-inspector', stableKey: 'fn:main' } },
      create: expect.objectContaining({ projectId: 'project-1', taskId: 'task-1', artifactId: 'artifact-1', stableKey: 'fn:main' }),
      update: expect.objectContaining({ taskId: 'task-1', type: 'function' }),
    }))
  })
})

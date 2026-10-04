/** @vitest-environment node */
import { describe, expect, test, vi } from 'vitest'
import { canonicalKeyForObservation, ingestToolResult, MAX_CODE_UNITS_PER_RESULT, parseToolFindings, parseToolObservations } from './result-ingestion'

describe('parseToolObservations', () => {
  test('accepts typed entities and relationships while rejecting unsafe shapes', () => {
    const result = parseToolObservations({
      observations: [
        { kind: 'entity', type: 'function', key: 'fn:main', label: 'main', attributes: { address: 4096, exported: true, ignored: ['nested'] } },
        { kind: 'relationship', type: 'calls', key: 'call:main->parse', fromKey: 'fn:main', toKey: 'fn:parse', toCanonicalKey: 'identity:function:parse', relation: 'calls', attributes: {} },
        { kind: 'relationship', type: 'calls', key: 'broken', fromKey: 'fn:main', attributes: {} },
        { kind: 'entity', type: 'function', key: 'fn:main', attributes: {} },
      ],
    })

    expect(result).toEqual({
      observations: [
        expect.objectContaining({ kind: 'entity', key: 'fn:main', attributes: { address: 4096, exported: true } }),
        expect.objectContaining({ kind: 'relationship', key: 'call:main->parse', fromKey: 'fn:main', toKey: 'fn:parse', toCanonicalKey: 'identity:function:parse' }),
      ],
      rejected: 2,
    })
  })

  test('ignores results without an observations array', () => {
    expect(parseToolObservations({ strings: ['hello'] })).toEqual({ observations: [], rejected: 0 })
  })

  test('allows bounded decompiler indexes to exceed the general observation cap', () => {
    const observations = Array.from({ length: 1200 }, (_, index) => ({
      kind: 'entity', type: 'code_unit', key: `unit:${index}`, attributes: { unitType: 'class', sizeBytes: 1 },
    }))

    const result = parseToolObservations({ observations }, MAX_CODE_UNITS_PER_RESULT)

    expect(result.observations).toHaveLength(1200)
    expect(result.rejected).toBe(0)
    expect(parseToolObservations({ observations })).toMatchObject({ rejected: 700 })
  })
})

describe('ingestToolResult', () => {
  test('bounds provider findings and rejects unsafe or duplicate entries', () => {
    expect(parseToolFindings({ findings: [
      { key: 'finding-1', title: 'Unsafe parser', severity: 'HIGH', description: 'bounded', data: { confidence: 0.9, ignored: ['nested'] } },
      { key: 'finding-1', title: 'duplicate', severity: 'low' },
      { key: 'bad', title: 'invalid severity', severity: 'urgent' },
    ] })).toEqual({
      findings: [expect.objectContaining({ key: 'finding-1', severity: 'high', data: { confidence: 0.9 } })],
      rejected: 2,
    })
  })

  test('derives provider-independent keys only from explicit identity hints', () => {
    const observation = { kind: 'entity' as const, type: 'function', key: 'provider-specific', attributes: { identity: 'com.example.Main' } }
    const first = canonicalKeyForObservation('provider-a', observation)
    const second = canonicalKeyForObservation('provider-b', { ...observation, key: 'different-key' })

    expect(first).toBe(second)
    expect(canonicalKeyForObservation('provider-a', { ...observation, attributes: {} })).toBe('source:provider-a:provider-specific')
  })

  test('upserts observations using the project, source, and stable key', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'observation-1' })
    const findingCreate = vi.fn().mockResolvedValue({ id: 'finding-1' })
    const tx = { reamonObservation: { upsert }, finding: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn(), create: findingCreate } } as never

    const summary = await ingestToolResult(tx, {
      projectId: 'project-1',
      taskId: 'task-1',
      targetId: 'target-1',
      artifactId: 'artifact-1',
      source: 'reamon-source-inspector',
      data: { observations: [{ kind: 'entity', type: 'function', key: 'fn:main', attributes: {} }] },
    })

    expect(summary).toEqual({ accepted: 1, rejected: 0, findingsAccepted: 0, findingsRejected: 0 })
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId_source_stableKey: { projectId: 'project-1', source: 'reamon-source-inspector', stableKey: 'fn:main' } },
      create: expect.objectContaining({ projectId: 'project-1', taskId: 'task-1', artifactId: 'artifact-1', stableKey: 'fn:main' }),
      update: expect.objectContaining({ taskId: 'task-1', type: 'function' }),
    }))
  })

  test('preserves explicit relationship endpoint identities for graph convergence', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'observation-2' })
    const tx = { reamonObservation: { upsert } } as never

    await ingestToolResult(tx, {
      projectId: 'project-1',
      taskId: 'task-1',
      targetId: null,
      artifactId: null,
      source: 'provider-b',
      data: { observations: [{ kind: 'relationship', type: 'calls', key: 'call:main->parse', fromKey: 'local-main', toKey: 'local-parse', fromCanonicalKey: 'identity:function:main', toCanonicalKey: 'identity:function:parse', attributes: {} }] },
    })

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ fromCanonicalKey: 'identity:function:main', toCanonicalKey: 'identity:function:parse' }),
      update: expect.objectContaining({ fromCanonicalKey: 'identity:function:main', toCanonicalKey: 'identity:function:parse' }),
    }))
  })

  test('persists normalized findings with source and task provenance', async () => {
    const findingCreate = vi.fn().mockResolvedValue({ id: 'finding-1' })
    const tx = { reamonObservation: { upsert: vi.fn() }, finding: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn(), create: findingCreate } } as never

    const summary = await ingestToolResult(tx, {
      projectId: 'project-1', taskId: 'task-1', targetId: 'target-1', artifactId: 'artifact-1', source: 'provider-a',
      data: { findings: [{ key: 'finding-1', title: 'Unsafe parser', severity: 'high', description: 'Review parser input', data: { confidence: 0.9 } }] },
    })

    expect(summary).toMatchObject({ accepted: 0, rejected: 0, findingsAccepted: 1, findingsRejected: 0 })
    expect(findingCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      projectId: 'project-1', taskId: 'task-1', source: 'provider-a', stableKey: 'finding-1', severity: 'high', status: 'OPEN',
    }) })
  })
})

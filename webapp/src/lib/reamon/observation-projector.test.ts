/** @vitest-environment node */
import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ default: { reamonObservation: { findMany: mocks.findMany } } }))

import { projectObservations, projectReamonObservations } from './observation-projector'

const entity = {
  id: 'observation-1', projectId: 'project-1', taskId: 'task-1', targetId: 'target-1', artifactId: 'artifact-1',
  kind: 'entity' as const, type: 'function', stableKey: 'fn:main', canonicalKey: 'identity:function:main', label: 'main', source: 'provider', relation: null,
  fromKey: null, toKey: null, fromCanonicalKey: null, toCanonicalKey: null, attributes: { address: 4096, exported: true }, updatedAt: '2026-10-02T12:00:00.000Z',
}

const relationship = {
  ...entity, id: 'observation-2', kind: 'relationship' as const, type: 'calls', stableKey: 'call:main->parse',
  label: null, relation: 'calls', fromKey: 'fn:main', toKey: 'fn:parse', fromCanonicalKey: null, toCanonicalKey: 'identity:function:parse', attributes: { confidence: 0.9 },
}

describe('projectObservations', () => {
  test('uses fixed project-scoped graph identifiers and batches both node and edge writes', async () => {
    const run = vi.fn().mockResolvedValue({ records: [] })
    const result = await projectObservations({ run } as never, [entity, relationship], 'project-1', 1)

    expect(result).toEqual({ nodes: 1, relationships: 1 })
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[0][1]).toMatchObject({
      projectId: 'project-1',
      observations: [expect.objectContaining({ stable_key: 'fn:main', reamon_attr_address: 4096 })],
    })
    expect(run.mock.calls[1][1]).toMatchObject({
      projectId: 'project-1',
      relationships: [expect.objectContaining({ stable_key: 'call:main->parse', from_key: 'identity:function:main', to_key: 'identity:function:parse' })],
    })
    expect(run.mock.calls[0][0]).toContain('MERGE (n:ReamonObservation')
    expect(run.mock.calls[1][0]).toContain('REAMON_RELATIONSHIP')
    expect(run.mock.calls[0][0]).not.toContain('function')
  })
})

describe('projectReamonObservations', () => {
  test('reads only the requested project and reports a bounded replay', async () => {
    mocks.findMany.mockResolvedValue([{ ...entity, updatedAt: new Date(entity.updatedAt) }])
    const result = await projectReamonObservations('project-1', { run: vi.fn().mockResolvedValue({ records: [] }) } as never, 10)

    expect(result).toMatchObject({ projectId: 'project-1', selected: 1, nodes: 1, relationships: 0, truncated: false })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: 'project-1' }, take: 11 }))
  })
})

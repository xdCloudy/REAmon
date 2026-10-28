import { describe, expect, test } from 'vitest'
import { prepareObservationImport } from './observation-import'

const sourceRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'source-observation', projectId: 'source-project', taskId: 'source-task', targetId: 'source-target',
  artifactId: 'source-artifact', kind: 'fact', type: 'protection_assessment', stableKey: 'artifact:run:protection',
  canonicalKey: 'identity:protection:123', label: 'Suspected UPX protection', source: 'reamon-protection-inspector',
  relation: null, fromKey: null, toKey: null, fromCanonicalKey: null, toCanonicalKey: null,
  attributes: { assessment: 'suspected', evidence: 'UPX section marker', confirmed: false }, isPending: false,
  createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:01:00.000Z', ...overrides,
})

describe('project observation import', () => {
  test('re-owns rows and retains old task/artifact references as provenance', () => {
    const { rows, skipped } = prepareObservationImport([sourceRow()], new Date('2026-10-28T00:00:00.000Z'))
    expect(skipped).toBe(0)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'fact', type: 'protection_assessment', stableKey: 'artifact:run:protection',
      canonicalKey: 'identity:protection:123', source: 'reamon-protection-inspector', isPending: false,
      attributes: {
        assessment: 'suspected', confirmed: false,
        importOrigin: { projectId: 'source-project', taskId: 'source-task', targetId: 'source-target', artifactId: 'source-artifact' },
      },
    })
    expect(rows[0].createdAt.toISOString()).toBe('2026-10-01T12:00:00.000Z')
  })

  test('rejects malformed, oversized, and duplicate provider identities', () => {
    const { rows, skipped } = prepareObservationImport([
      sourceRow(), sourceRow(), sourceRow({ attributes: { evidence: 'x'.repeat(70 * 1024) } }),
      sourceRow({ canonicalKey: '' }), null,
    ])
    expect(rows).toHaveLength(1)
    expect(skipped).toBe(4)
  })

  test('does not reactivate a pending observation as accepted evidence', () => {
    const { rows } = prepareObservationImport([sourceRow({ isPending: true })])
    expect(rows[0].isPending).toBe(true)
  })
})

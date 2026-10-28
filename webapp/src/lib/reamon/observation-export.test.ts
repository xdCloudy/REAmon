import { describe, expect, test } from 'vitest'
import { serializeProjectObservations, type ProjectObservationExportRow } from './observation-export'

describe('project observation export', () => {
  test('preserves canonical identity, source links, evidence, and review state', () => {
    const row: ProjectObservationExportRow = {
      id: 'obs-1', projectId: 'project-1', taskId: 'task-2', targetId: 'target-3', artifactId: 'artifact-4',
      kind: 'fact', type: 'protection_assessment', stableKey: 'artifact-4:run-5:protection-static-v1',
      canonicalKey: 'source:reamon-protection-inspector:artifact-4:run-5',
      label: 'Suspected UPX protection', source: 'reamon-protection-inspector', relation: null,
      fromKey: null, toKey: null, fromCanonicalKey: null, toCanonicalKey: null,
      attributes: { assessment: 'suspected', evidence: 'UPX marker observed', confirmed: false },
      isPending: false, createdAt: new Date('2026-10-01T12:00:00.000Z'), updatedAt: new Date('2026-10-01T12:01:00.000Z'),
    }

    expect(serializeProjectObservations([row])).toEqual([{
      ...row,
      createdAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-01T12:01:00.000Z',
    }])
  })
})

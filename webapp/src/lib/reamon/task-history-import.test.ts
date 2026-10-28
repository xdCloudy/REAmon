import { describe, expect, test } from 'vitest'
import { prepareTaskHistoryImport } from './task-history-import'

const sourceTask = (overrides: Record<string, unknown> = {}) => ({
  id: 'source-task', targetId: 'source-target', artifactId: 'source-artifact',
  providerPluginId: 'reamon-ghidra', capability: 'decompile', title: 'Decompile binary',
  category: 'analysis', status: 'COMPLETED', progress: 100, progressMessage: 'Finished',
  startedAt: '2026-10-01T11:00:00.000Z', completedAt: '2026-10-01T11:02:00.000Z',
  createdAt: '2026-10-01T10:59:00.000Z', updatedAt: '2026-10-01T11:02:00.000Z',
  options: { apiKey: 'must-not-be-copied' }, result: { source: 'large provider output' },
  runToken: 'old-run-token', idempotencyKey: 'old-key', ...overrides,
})

describe('project task history import', () => {
  test('creates a new inert task identity and keeps old references as provenance', () => {
    const { rows, idMap, skipped } = prepareTaskHistoryImport([sourceTask()], 'new-project', new Date('2026-10-28T00:00:00.000Z'))
    expect(skipped).toBe(0)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).not.toBe('source-task')
    expect(idMap.get('source-task')).toBe(rows[0].id)
    expect(rows[0]).toMatchObject({
      projectId: 'new-project', targetId: null, artifactId: null, providerId: null,
      status: 'IMPORTED', progress: 0, error: '', runToken: null, idempotencyKey: null,
      options: {
        importOrigin: {
          taskId: 'source-task', targetId: 'source-target', artifactId: 'source-artifact',
          providerPluginId: 'reamon-ghidra', status: 'COMPLETED', progress: 100,
        },
      },
    })
    expect(rows[0].options).not.toHaveProperty('apiKey')
    expect(rows[0]).not.toHaveProperty('result')
  })

  test('skips malformed and duplicate task identities', () => {
    const { rows, skipped } = prepareTaskHistoryImport([
      sourceTask(), sourceTask(), sourceTask({ id: '../bad' }), null,
    ], 'new-project')
    expect(rows).toHaveLength(1)
    expect(skipped).toBe(3)
  })
})

import { describe, expect, test } from 'vitest'
import { serializeProjectTaskHistory } from './task-history-export'

describe('project task history export', () => {
  test('exports bounded history fields without execution payloads', () => {
    const row = {
      id: 'task-1', targetId: 'target-1', artifactId: 'artifact-1', capability: 'decompile',
      title: 'Decompile binary', category: 'analysis', status: 'COMPLETED', progress: 100,
      progressMessage: 'Finished', startedAt: new Date('2026-10-01T11:00:00.000Z'),
      completedAt: new Date('2026-10-01T11:02:00.000Z'), createdAt: new Date('2026-10-01T10:59:00.000Z'),
      updatedAt: new Date('2026-10-01T11:02:00.000Z'), provider: { pluginId: 'reamon-ghidra' },
    }
    const serialized = serializeProjectTaskHistory([{ ...row, options: { apiKey: 'secret' }, result: { source: 'payload' } }])

    expect(serialized).toEqual([{
      id: row.id, targetId: row.targetId, artifactId: row.artifactId, capability: row.capability,
      title: row.title, category: row.category, status: row.status, progress: row.progress,
      startedAt: '2026-10-01T11:00:00.000Z', completedAt: '2026-10-01T11:02:00.000Z',
      createdAt: '2026-10-01T10:59:00.000Z', updatedAt: '2026-10-01T11:02:00.000Z',
      providerPluginId: 'reamon-ghidra',
    }])
    expect(serialized[0]).not.toHaveProperty('options')
    expect(serialized[0]).not.toHaveProperty('result')
  })
})

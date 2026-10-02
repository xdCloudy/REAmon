/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  taskFindFirst: vi.fn(),
  taskUpdateMany: vi.fn(),
  taskSettleUpdateMany: vi.fn(),
  taskFindUnique: vi.fn(),
  evidenceCreate: vi.fn(),
  observationUpsert: vi.fn(),
  activityCreate: vi.fn(),
  transaction: vi.fn(),
  getBuiltinProvider: vi.fn(),
  resolveCapabilities: vi.fn(),
  analyze: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    task: { findFirst: mocks.taskFindFirst, updateMany: mocks.taskUpdateMany },
    $transaction: mocks.transaction,
  },
}))
vi.mock('./provider-registry', () => ({ getBuiltinProvider: mocks.getBuiltinProvider }))
vi.mock('./capabilities', () => ({ resolveCapabilities: mocks.resolveCapabilities }))

import { executeAnalysisTask } from './task-executor'

const provider = {
  manifest: {
    id: 'reamon-source-inspector', name: 'REAmon Source Inspector', category: 'static_analysis', integration: 'native',
    acceptsTargetTypes: ['FILE'], acceptsFormats: ['source'], capabilities: ['extract_strings'], produces: ['String'], requirements: [],
  },
  analyze: mocks.analyze,
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1', projectId: 'project-1', targetId: 'target-1', artifactId: 'artifact-1', providerId: 'provider-1',
    capability: 'extract_strings', title: 'Inspect source', category: 'static_analysis', status: 'QUEUED', progress: 0,
    options: { mode: 'conservative' }, result: null, error: '', startedAt: null, completedAt: null,
    createdAt: new Date('2026-10-02T12:00:00Z'), updatedAt: new Date('2026-10-02T12:00:00Z'),
    provider: { id: 'provider-1', pluginId: provider.manifest.id, name: provider.manifest.name, enabled: true },
    artifact: { id: 'artifact-1', targetId: 'target-1', relativePath: 'src/main.c', profile: { targetType: 'FILE', format: 'source' } },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.taskFindFirst.mockResolvedValue(task())
  mocks.taskUpdateMany.mockResolvedValue({ count: 1 })
  mocks.taskSettleUpdateMany.mockResolvedValue({ count: 1 })
  mocks.taskFindUnique.mockResolvedValue(task({ status: 'COMPLETED', progress: 100, result: { strings: ['hello'] }, completedAt: new Date('2026-10-02T12:01:00Z') }))
  mocks.evidenceCreate.mockResolvedValue({ id: 'evidence-1' })
  mocks.observationUpsert.mockResolvedValue({ id: 'observation-1' })
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    task: { updateMany: mocks.taskSettleUpdateMany, findUnique: mocks.taskFindUnique },
    evidence: { create: mocks.evidenceCreate },
    reamonObservation: { upsert: mocks.observationUpsert },
    workspaceActivity: { create: mocks.activityCreate },
  }))
  mocks.getBuiltinProvider.mockReturnValue(provider)
  mocks.resolveCapabilities.mockReturnValue([{ capabilities: ['extract_strings'] }])
  mocks.analyze.mockResolvedValue({
    status: 'completed', toolId: provider.manifest.id, capabilities: ['extract_strings'], produced: ['String'], data: {
      strings: ['hello'],
      observations: [{ kind: 'entity', type: 'function', key: 'fn:main', label: 'main', attributes: { address: 4096 } }],
    },
  })
})

describe('executeAnalysisTask', () => {
  test('claims a queued task, invokes its provider, and records evidence and activity', async () => {
    const result = await executeAnalysisTask('project-1', 'task-1')

    expect(result).toMatchObject({ outcome: 'COMPLETED', task: { status: 'COMPLETED', progress: 100 } })
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-1', projectId: 'project-1', status: 'QUEUED' },
      data: expect.objectContaining({ status: 'RUNNING', progress: 10 }),
    }))
    expect(mocks.analyze).toHaveBeenCalledWith({
      targetProfile: { targetType: 'FILE', format: 'source' }, artifactId: 'artifact-1', options: { mode: 'conservative' },
    })
    expect(mocks.evidenceCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'analysis', source: provider.manifest.id, artifactId: 'artifact-1' }),
    }))
    expect(mocks.observationUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId_source_stableKey: { projectId: 'project-1', source: provider.manifest.id, stableKey: 'fn:main' } },
    }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'analysis.task.completed', data: expect.objectContaining({
        taskId: 'task-1', observations: { accepted: 1, rejected: 0 },
      }) }),
    }))
  })

  test('persists a provider failure without creating false evidence', async () => {
    mocks.analyze.mockResolvedValue({
      status: 'failed', toolId: provider.manifest.id, capabilities: ['extract_strings'], produced: [], data: {}, error: 'provider unavailable',
    })
    mocks.taskFindUnique.mockResolvedValue(task({ status: 'FAILED', error: 'provider unavailable' }))

    const result = await executeAnalysisTask('project-1', 'task-1')

    expect(result).toMatchObject({ outcome: 'FAILED', task: { status: 'FAILED', error: 'provider unavailable' } })
    expect(mocks.evidenceCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'analysis.task.failed' }),
    }))
  })

  test('does not settle or create evidence after its lease is recovered', async () => {
    mocks.taskSettleUpdateMany.mockResolvedValue({ count: 0 })
    mocks.taskFindFirst
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ status: 'QUEUED', progress: 0, runToken: null, startedAt: null }))

    const result = await executeAnalysisTask('project-1', 'task-1')

    expect(result).toMatchObject({ outcome: 'SKIPPED', task: { status: 'QUEUED' } })
    expect(mocks.evidenceCreate).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  test('does not rerun a task that is already running', async () => {
    mocks.taskFindFirst.mockResolvedValue(task({ status: 'RUNNING', progress: 10 }))

    const result = await executeAnalysisTask('project-1', 'task-1')

    expect(result).toMatchObject({ outcome: 'SKIPPED', task: { status: 'RUNNING' } })
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled()
    expect(mocks.analyze).not.toHaveBeenCalled()
  })
})

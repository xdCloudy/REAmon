/** @vitest-environment node */
import path from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  taskFindFirst: vi.fn(),
  taskUpdateMany: vi.fn(),
  taskSettleUpdateMany: vi.fn(),
  taskFindUnique: vi.fn(),
  evidenceCreate: vi.fn(),
  findingFindFirst: vi.fn(),
  findingUpdate: vi.fn(),
  findingCreate: vi.fn(),
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
import type { ToolResult } from './types'

const provider = {
  manifest: {
    id: 'reamon-source-inspector', name: 'REAmon Strings Inspector', category: 'static_analysis', integration: 'native',
    acceptsTargetTypes: ['FILE'], acceptsFormats: ['*'], capabilities: ['extract_strings'], produces: ['String'], requirements: [],
  },
  analyze: mocks.analyze,
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1', projectId: 'project-1', targetId: 'target-1', artifactId: 'artifact-1', providerId: 'provider-1',
    capability: 'extract_strings', title: 'Inspect source', category: 'static_analysis', status: 'QUEUED', progress: 0,
    options: { mode: 'conservative' }, result: null, error: '', startedAt: null, completedAt: null,
    leaseHeartbeatAt: null, leaseOwner: null,
    createdAt: new Date('2026-10-02T12:00:00Z'), updatedAt: new Date('2026-10-02T12:00:00Z'),
    provider: { id: 'provider-1', pluginId: provider.manifest.id, name: provider.manifest.name, enabled: true },
    artifact: { id: 'artifact-1', targetId: 'target-1', relativePath: 'src/main.c', storagePath: 'project-1/import-1/artifact-1', profile: { targetType: 'FILE', format: 'source' } },
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
    finding: { findFirst: mocks.findingFindFirst, update: mocks.findingUpdate, create: mocks.findingCreate },
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
      data: expect.objectContaining({ status: 'RUNNING', progress: 10, leaseOwner: 'webapp' }),
    }))
    expect(mocks.analyze).toHaveBeenCalledWith(expect.objectContaining({
      targetProfile: { targetType: 'FILE', format: 'source' }, artifactId: 'artifact-1', projectId: 'project-1', taskId: 'task-1', runToken: expect.any(String), artifactPath: expect.stringContaining(path.join('project-1', 'import-1', 'artifact-1')), options: { mode: 'conservative' }, signal: expect.any(AbortSignal), reportProgress: expect.any(Function),
    }))
    expect(mocks.evidenceCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: 'analysis', source: provider.manifest.id, artifactId: 'artifact-1' }),
    }))
    expect(mocks.observationUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId_source_stableKey: { projectId: 'project-1', source: provider.manifest.id, stableKey: 'fn:main' } },
    }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'analysis.task.completed', data: expect.objectContaining({
        taskId: 'task-1', observations: expect.objectContaining({ accepted: 1, rejected: 0, findingsAccepted: 0 }),
      }) }),
    }))
  })

  test('persists bounded progress messages under the active run lease', async () => {
    mocks.analyze.mockImplementation(async (input: { reportProgress?: (message: string) => Promise<void> | void }) => {
      await input.reportProgress?.('  Indexing Java source 4 of 12  ')
      return {
        status: 'completed', toolId: provider.manifest.id, capabilities: ['extract_strings'], produced: ['String'],
        data: { strings: [], observations: [] },
      }
    })

    await executeAnalysisTask('project-1', 'task-1')

    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'task-1', projectId: 'project-1', status: 'RUNNING', runToken: expect.any(String) }),
      data: expect.objectContaining({ progressMessage: 'Indexing Java source 4 of 12', leaseHeartbeatAt: expect.any(Date) }),
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

  test('bounds persisted provider payloads while retaining normalized observations', async () => {
    vi.stubEnv('REAMON_MAX_RESULT_BYTES', '65536')
    mocks.analyze.mockResolvedValue({
      status: 'completed', toolId: provider.manifest.id, capabilities: ['extract_strings'], produced: ['String'], data: {
        output: 'x'.repeat(100_000),
        observations: [{ kind: 'entity', type: 'function', key: 'fn:bounded', attributes: {} }],
      },
    })

    await executeAnalysisTask('project-1', 'task-1')

    const persistedResult = mocks.taskSettleUpdateMany.mock.calls[0][0].data.result
    expect(persistedResult).toMatchObject({ _reamonTruncated: true, maxBytes: 65_536, reason: 'size' })
    expect(persistedResult.originalBytes).toBeGreaterThan(65_536)
    expect(mocks.evidenceCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ data: persistedResult }),
    }))
    expect(mocks.observationUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId_source_stableKey: { projectId: 'project-1', source: provider.manifest.id, stableKey: 'fn:bounded' } },
    }))
  })

  test('persists decompiler run metrics without duplicating large observation arrays', async () => {
    const observations = Array.from({ length: 600 }, (_, index) => ({
      kind: 'entity', type: 'code_unit', key: `class:${index}`, label: `Class${index}`,
      attributes: { unitType: 'class', sizeBytes: 1024, decompiled: true, codeArtifactId: `sources/Class${index}.java` },
    }))
    mocks.analyze.mockResolvedValue({
      status: 'completed', toolId: 'reamon-jadx', capabilities: ['decompile'], produced: ['CodeUnit', 'DecompiledSource'], data: {
        decompiledClassCount: 600, returnedClassCount: 600, codeBytes: 819200, truncated: false, warnings: '', observations,
      },
    })

    await executeAnalysisTask('project-1', 'task-1')

    const persistedResult = mocks.taskSettleUpdateMany.mock.calls[0][0].data.result
    expect(persistedResult).toEqual({
      decompiledClassCount: 600,
      returnedClassCount: 600,
      codeBytes: 819200,
      truncated: false,
      warnings: '',
      normalizedObservationCount: 600,
    })
    expect(mocks.observationUpsert).toHaveBeenCalledTimes(600)
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 10_000, timeout: 120_000 })
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ progressMessage: 'Saving analyzer results to the workspace' }),
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

  test('allows only one provider execution when two workers claim the same task', async () => {
    let initialReads = 0
    mocks.taskFindFirst.mockImplementation(async (input: { where?: { status?: string } }) => {
      if (input.where?.status === 'CANCELLED') return null
      initialReads += 1
      return initialReads <= 2 ? task() : task({ status: 'RUNNING', leaseOwner: 'worker-a' })
    })
    mocks.taskUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })

    let release!: (result: ToolResult) => void
    mocks.analyze.mockImplementation(() => new Promise<ToolResult>((resolve) => { release = resolve }))

    const first = executeAnalysisTask('project-1', 'task-1', 'worker-a')
    const second = executeAnalysisTask('project-1', 'task-1', 'worker-b')
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(mocks.analyze).toHaveBeenCalledOnce()
    release({
      status: 'completed', toolId: provider.manifest.id, capabilities: ['extract_strings'], produced: ['String'], data: { strings: ['hello'] },
    })
    const results = await Promise.all([first, second])

    expect(results.map((result) => result?.outcome)).toEqual(['COMPLETED', 'SKIPPED'])
    expect(mocks.evidenceCreate).toHaveBeenCalledOnce()
  })

  test('stress: settles each task once when many workers contend across a batch', async () => {
    const taskCount = 24
    const workerCount = 8
    const states = new Map<string, { status: 'QUEUED' | 'RUNNING' | 'COMPLETED'; runToken: string | null }>(
      Array.from({ length: taskCount }, (_, index) => [`task-${index + 1}`, { status: 'QUEUED', runToken: null }]),
    )
    const executions = new Map<string, number>()
    const rowFor = (id: string) => {
      const state = states.get(id)
      return task({
        id,
        artifactId: `artifact-${id}`,
        status: state?.status || 'QUEUED',
        runToken: state?.runToken,
        artifact: { id: `artifact-${id}`, targetId: 'target-1', relativePath: `${id}.c`, storagePath: `project-1/import-1/${id}`, profile: { targetType: 'FILE', format: 'source' } },
      })
    }
    const pause = () => new Promise<void>((resolve) => setImmediate(resolve))

    mocks.taskFindFirst.mockImplementation(async (input: { where?: { id?: string; status?: string } }) => {
      await pause()
      const id = input.where?.id || 'task-1'
      const state = states.get(id)
      if (input.where?.status === 'CANCELLED') return null
      return state ? rowFor(id) : null
    })
    mocks.taskUpdateMany.mockImplementation(async (input: { where: { id: string; status: string; runToken?: string }; data: { status: 'RUNNING'; runToken?: string } }) => {
      await pause()
      const state = states.get(input.where.id)
      if (!state || state.status !== input.where.status || (input.where.runToken && state.runToken !== input.where.runToken)) return { count: 0 }
      if (input.data.status === 'RUNNING') {
        state.status = 'RUNNING'
        state.runToken = input.data.runToken || null
      }
      return { count: 1 }
    })
    mocks.taskSettleUpdateMany.mockImplementation(async (input: { where: { id: string; status: string; runToken: string }; data: { status: 'COMPLETED' } }) => {
      await pause()
      const state = states.get(input.where.id)
      if (!state || state.status !== input.where.status || state.runToken !== input.where.runToken) return { count: 0 }
      state.status = input.data.status
      return { count: 1 }
    })
    mocks.taskFindUnique.mockImplementation(async (input: { where: { id: string } }) => rowFor(input.where.id))
    mocks.analyze.mockImplementation(async ({ artifactId }: { artifactId?: string }) => {
      await pause()
      const id = artifactId?.replace('artifact-', '') || 'unknown'
      executions.set(id, (executions.get(id) || 0) + 1)
      return {
        status: 'completed', toolId: provider.manifest.id, capabilities: ['extract_strings'], produced: ['String'], data: {
          strings: ['hello'],
          observations: [{ kind: 'entity', type: 'function', key: `fn:${id}`, label: 'main', attributes: { address: 4096 } }],
        },
      }
    })

    const attempts = Array.from(states.keys()).flatMap((taskId) =>
      Array.from({ length: workerCount }, (_, worker) => executeAnalysisTask('project-1', taskId, `worker-${worker + 1}`)),
    )
    const results = await Promise.all(attempts)

    expect(executions.size).toBe(taskCount)
    expect([...executions.values()]).toEqual(Array(taskCount).fill(1))
    expect(mocks.evidenceCreate).toHaveBeenCalledTimes(taskCount)
    expect(mocks.observationUpsert).toHaveBeenCalledTimes(taskCount)
    expect(results.filter((result) => result?.outcome === 'COMPLETED')).toHaveLength(taskCount)
    expect(results.filter((result) => result?.outcome === 'SKIPPED')).toHaveLength(taskCount * (workerCount - 1))
  })

  test('refreshes the lease while a provider is still running', async () => {
    vi.useFakeTimers()
    const previousHeartbeatSeconds = process.env.REAMON_TASK_HEARTBEAT_SECONDS
    process.env.REAMON_TASK_HEARTBEAT_SECONDS = '5'
    let finish!: (value: ToolResult) => void
    mocks.analyze.mockImplementation(() => new Promise<ToolResult>((resolve) => {
      finish = resolve
    }))

    try {
      const executing = executeAnalysisTask('project-1', 'task-1')
      await vi.advanceTimersByTimeAsync(5000)

      expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'task-1', projectId: 'project-1', status: 'RUNNING', runToken: expect.any(String) },
        data: { leaseHeartbeatAt: expect.any(Date) },
      }))

      finish({
        status: 'completed', toolId: provider.manifest.id, capabilities: ['extract_strings'], produced: ['String'], data: { strings: ['hello'] },
      })
      await executing
    } finally {
      if (previousHeartbeatSeconds === undefined) delete process.env.REAMON_TASK_HEARTBEAT_SECONDS
      else process.env.REAMON_TASK_HEARTBEAT_SECONDS = previousHeartbeatSeconds
      vi.useRealTimers()
    }
  })

  test('aborts a provider signal when its task is cancelled', async () => {
    mocks.taskFindFirst
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task({ status: 'CANCELLED', runToken: null }))
      .mockResolvedValueOnce(task({ status: 'CANCELLED', runToken: null }))
    mocks.taskSettleUpdateMany.mockResolvedValue({ count: 0 })
    mocks.analyze.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
      await Promise.resolve()
      expect(signal?.aborted).toBe(true)
      return {
        status: 'completed', toolId: provider.manifest.id, capabilities: ['extract_strings'], produced: ['String'], data: { strings: ['hello'] },
      }
    })

    const result = await executeAnalysisTask('project-1', 'task-1', 'worker-a')

    expect(result).toMatchObject({ outcome: 'SKIPPED', task: { status: 'CANCELLED' } })
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ leaseOwner: 'worker-a' }) }))
    expect(mocks.analyze).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(mocks.evidenceCreate).not.toHaveBeenCalled()
  })
})

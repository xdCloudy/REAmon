import { describe, expect, test, vi } from 'vitest'
import { dispatchOnce, listBackfillProjects, projectOnce, readWorkerConfig, runRetentionOnce, runWorker, WorkerConfigurationError } from './reamon-task-worker.mjs'

describe('REAmon task worker', () => {
  test('requires a real internal key and clamps worker settings', () => {
    expect(() => readWorkerConfig({ INTERNAL_API_KEY: 'changeme' })).toThrow(WorkerConfigurationError)
    expect(() => readWorkerConfig({ INTERNAL_API_KEY: 'secret', REAMON_WORKER_ID: '../worker' })).toThrow(WorkerConfigurationError)
    expect(readWorkerConfig({
      INTERNAL_API_KEY: 'secret',
      REAMON_WORKER_WEBAPP_URL: 'http://webapp:3000/',
      REAMON_WORKER_POLL_SECONDS: '999',
      REAMON_WORKER_BATCH_SIZE: '99',
      REAMON_WORKER_STALE_AFTER_MINUTES: '1',
      REAMON_WORKER_BACKFILL_INTERVAL_SECONDS: '999999',
      REAMON_WORKER_BACKFILL_BATCH_SIZE: '99',
      REAMON_WORKER_ID: 'worker-a',
    })).toMatchObject({ webappUrl: 'http://webapp:3000', pollSeconds: 300, batchSize: 10, staleAfterMinutes: 5, backfillIntervalSeconds: 86400, backfillBatchSize: 10, workerId: 'worker-a' })
  })

  test('dispatches with internal auth and bounded recovery settings', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ recovered: 1, selected: 2, results: [{ outcome: 'COMPLETED' }] }),
    })
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const result = await dispatchOnce({ webappUrl: 'http://webapp:3000', internalKey: 'secret', workerId: 'worker-a', batchSize: 2, staleAfterMinutes: 30 }, fetchImpl, logger)

    expect(result).toMatchObject({ recovered: 1, selected: 2 })
    expect(fetchImpl).toHaveBeenCalledWith('http://webapp:3000/api/internal/reamon/tasks/dispatch', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'secret' },
      body: JSON.stringify({ limit: 2, recoverStale: true, staleAfterMinutes: 30, workerId: 'worker-a' }),
    }))
  })

  test('replays a completed project through the graph projection route', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ projectId: 'project-1', nodes: 2, relationships: 1 }),
    })
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const result = await projectOnce({ webappUrl: 'http://webapp:3000', internalKey: 'secret', workerId: 'worker-a' }, 'project-1', fetchImpl, logger)

    expect(result).toMatchObject({ projectId: 'project-1', nodes: 2 })
    expect(fetchImpl).toHaveBeenCalledWith('http://webapp:3000/api/internal/reamon/graph/project', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'secret' },
      body: JSON.stringify({ projectId: 'project-1' }),
    }))
  })

  test('lists historical backfill projects with internal auth and bounded pagination', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ projects: ['project-1'], truncated: false, nextOffset: null }) })
    const result = await listBackfillProjects({ webappUrl: 'http://webapp:3000', internalKey: 'secret', backfillBatchSize: 5 }, fetchImpl, { warn: vi.fn() }, 10)

    expect(result).toMatchObject({ projects: ['project-1'] })
    expect(fetchImpl).toHaveBeenCalledWith('http://webapp:3000/api/internal/reamon/graph/backfill', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'secret' },
      body: JSON.stringify({ limit: 5, offset: 10 }),
    }))
  })

  test('continues a truncated projection from the server-provided offset', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ projectId: 'project-1', offset: 100, nextOffset: 200, truncated: true, nodes: 2, relationships: 1 }),
    })
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    await projectOnce({ webappUrl: 'http://webapp:3000', internalKey: 'secret', workerId: 'worker-a' }, 'project-1', fetchImpl, logger, 100)

    expect(fetchImpl).toHaveBeenCalledWith('http://webapp:3000/api/internal/reamon/graph/project', expect.objectContaining({
      body: JSON.stringify({ projectId: 'project-1', offset: 100 }),
    }))
  })

  test('projects each distinct project with completed work after a poll', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ recovered: 0, selected: 3, results: [
          { outcome: 'COMPLETED', task: { projectId: 'project-1' } },
          { outcome: 'COMPLETED', task: { projectId: 'project-1' } },
          { outcome: 'FAILED', task: { projectId: 'project-2' } },
        ] }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ offset: 0, nextOffset: 1, projectionRunId: 'run-1', truncated: true, nodes: 1, relationships: 0 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ offset: 1, nextOffset: null, truncated: false, nodes: 0, relationships: 0 }) })
    let stopped = false
    await runWorker(
      { webappUrl: 'http://webapp:3000', internalKey: 'secret', workerId: 'worker-a', batchSize: 1, pollSeconds: 1, staleAfterMinutes: 30 },
      { fetchImpl, sleepImpl: async () => { stopped = true }, shouldStop: () => stopped, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    )

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls[1][0]).toBe('http://webapp:3000/api/internal/reamon/graph/project')
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({ projectId: 'project-1', offset: 1, projectionRunId: 'run-1' })
  })

  test('round-robins a bounded historical backfill page', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ recovered: 0, selected: 0, results: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ projects: ['project-old'], truncated: false, nextOffset: null }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ offset: 0, truncated: false, nodes: 1, relationships: 0 }) })
    let stopped = false
    await runWorker(
      { webappUrl: 'http://webapp:3000', internalKey: 'secret', workerId: 'worker-a', batchSize: 1, pollSeconds: 1, staleAfterMinutes: 30, backfillIntervalSeconds: 300, backfillBatchSize: 2 },
      { fetchImpl, sleepImpl: async () => { stopped = true }, shouldStop: () => stopped, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
    )

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls[1][0]).toBe('http://webapp:3000/api/internal/reamon/graph/backfill')
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ limit: 2, offset: 0 })
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({ projectId: 'project-old' })
  })

  test('runs retention in dry-run mode by default and never sends credentials in the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ candidates: 2, deleted: 0 }) })
    const result = await runRetentionOnce({ webappUrl: 'http://webapp:3000', internalKey: 'secret', retentionApply: false }, fetchImpl, { info: vi.fn(), warn: vi.fn() })
    expect(result).toMatchObject({ candidates: 2, deleted: 0 })
    expect(fetchImpl).toHaveBeenCalledWith('http://webapp:3000/api/internal/reamon/imports/retention', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'secret' },
      body: JSON.stringify({ apply: false }),
    }))
  })
})

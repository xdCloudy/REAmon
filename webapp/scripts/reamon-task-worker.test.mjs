import { describe, expect, test, vi } from 'vitest'
import { dispatchOnce, readWorkerConfig, WorkerConfigurationError } from './reamon-task-worker.mjs'

describe('REAmon task worker', () => {
  test('requires a real internal key and clamps worker settings', () => {
    expect(() => readWorkerConfig({ INTERNAL_API_KEY: 'changeme' })).toThrow(WorkerConfigurationError)
    expect(readWorkerConfig({
      INTERNAL_API_KEY: 'secret',
      REAMON_WORKER_WEBAPP_URL: 'http://webapp:3000/',
      REAMON_WORKER_POLL_SECONDS: '999',
      REAMON_WORKER_BATCH_SIZE: '99',
      REAMON_WORKER_STALE_AFTER_MINUTES: '1',
    })).toMatchObject({ webappUrl: 'http://webapp:3000', pollSeconds: 300, batchSize: 10, staleAfterMinutes: 5 })
  })

  test('dispatches with internal auth and bounded recovery settings', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ recovered: 1, selected: 2, results: [{ outcome: 'COMPLETED' }] }),
    })
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const result = await dispatchOnce({ webappUrl: 'http://webapp:3000', internalKey: 'secret', batchSize: 2, staleAfterMinutes: 30 }, fetchImpl, logger)

    expect(result).toMatchObject({ recovered: 1, selected: 2 })
    expect(fetchImpl).toHaveBeenCalledWith('http://webapp:3000/api/internal/reamon/tasks/dispatch', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'secret' },
      body: JSON.stringify({ limit: 2, recoverStale: true, staleAfterMinutes: 30 }),
    }))
  })
})

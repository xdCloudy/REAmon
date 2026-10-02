import { describe, expect, test, vi } from 'vitest'
import { notifyWorkerAlert, readWorkerAlertConfig, WorkerAlertConfigurationError } from './worker-alerts'

const degradedInput = {
  workerId: 'worker-a',
  recovered: 1,
  selected: 2,
  completed: 1,
  failed: 1,
  durationMs: 42,
  error: ` ${'x'.repeat(600)} `,
}

describe('REAmon worker alerts', () => {
  test('requires an absolute http(s) URL without embedded credentials', () => {
    expect(() => readWorkerAlertConfig({ REAMON_WORKER_ALERT_WEBHOOK_URL: 'not-a-url' })).toThrow(WorkerAlertConfigurationError)
    expect(() => readWorkerAlertConfig({ REAMON_WORKER_ALERT_WEBHOOK_URL: 'ftp://alerts.example.test/hook' })).toThrow(WorkerAlertConfigurationError)
    expect(() => readWorkerAlertConfig({ REAMON_WORKER_ALERT_WEBHOOK_URL: 'https://user:pass@alerts.example.test/hook' })).toThrow(WorkerAlertConfigurationError)
    expect(readWorkerAlertConfig({ REAMON_WORKER_ALERT_WEBHOOK_URL: 'https://alerts.example.test/hook', REAMON_WORKER_ALERT_WEBHOOK_TOKEN: 'secret' })).toEqual({ url: 'https://alerts.example.test/hook', token: 'secret' })
  })

  test('sends a bounded degraded payload with optional bearer authentication', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 202 })
    const result = await notifyWorkerAlert(degradedInput, {
      fetchImpl,
      env: { REAMON_WORKER_ALERT_WEBHOOK_URL: 'https://alerts.example.test/hook', REAMON_WORKER_ALERT_WEBHOOK_TOKEN: 'secret' },
    })

    expect(result).toEqual({ configured: true, delivered: true })
    expect(fetchImpl).toHaveBeenCalledWith('https://alerts.example.test/hook', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer secret' }),
    }))
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string)
    expect(body).toMatchObject({ source: 'reamon', event: 'worker.degraded', workerId: 'worker-a', failed: 1 })
    expect(body.error).toHaveLength(500)
  })

  test('never turns webhook failure into a dispatch failure', async () => {
    const logger = { warn: vi.fn() }
    const result = await notifyWorkerAlert(degradedInput, {
      fetchImpl: vi.fn().mockRejectedValue(new Error('connection refused')),
      logger,
      env: { REAMON_WORKER_ALERT_WEBHOOK_URL: 'https://alerts.example.test/hook' },
    })

    expect(result).toEqual({ configured: true, delivered: false, reason: 'delivery_failed' })
    expect(logger.warn).toHaveBeenCalled()
  })

  test('does not call a webhook for a healthy dispatch or when it is not configured', async () => {
    const fetchImpl = vi.fn()
    await expect(notifyWorkerAlert({ ...degradedInput, failed: 0, error: '' }, { fetchImpl })).resolves.toMatchObject({ reason: 'healthy' })
    await expect(notifyWorkerAlert(degradedInput, { fetchImpl, env: {} })).resolves.toMatchObject({ reason: 'not_configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

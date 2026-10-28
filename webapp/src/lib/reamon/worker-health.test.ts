import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  worker: {
    upsert: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
}))

vi.mock('@/lib/prisma', () => ({ default: { reamonWorker: mocks.worker } }))

import { getWorkerHeartbeatStatus, listWorkerHealth, recordWorkerDispatch, summarizeWorkerAttention } from './worker-health'

describe('REAmon worker health', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('REAMON_WORKER_STALE_SECONDS', '90')
    mocks.worker.upsert.mockResolvedValue({ workerId: 'worker-a' })
  })

  test('records bounded dispatch outcomes for operator health', async () => {
    await recordWorkerDispatch({ workerId: 'worker-a', recovered: 1, selected: 2, completed: 1, failed: 1, durationMs: 42, error: 'provider failed' })

    expect(mocks.worker.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workerId: 'worker-a' },
      create: expect.objectContaining({ status: 'DEGRADED', lastFailed: 1, lastError: 'provider failed' }),
      update: expect.objectContaining({ status: 'DEGRADED', lastSelected: 2, lastDispatchDurationMs: 42 }),
    }))
  })

  test('marks workers stale without losing their last dispatch details', async () => {
    mocks.worker.findMany.mockResolvedValue([
      {
        workerId: 'worker-a',
        status: 'IDLE',
        lastSeenAt: new Date(Date.now() - 120_000),
        lastDispatchAt: new Date(Date.now() - 120_000),
        lastDispatchDurationMs: 12,
        lastRecovered: 0,
        lastSelected: 1,
        lastCompleted: 1,
        lastFailed: 0,
        lastError: '',
      },
    ])

    await expect(listWorkerHealth()).resolves.toEqual([expect.objectContaining({ workerId: 'worker-a', status: 'STALE', lastSelected: 1 })])
  })

  test('reports heartbeat freshness for Docker worker health checks', async () => {
    const now = Date.now()
    mocks.worker.findUnique.mockResolvedValue({
      workerId: 'worker-a',
      status: 'IDLE',
      lastSeenAt: new Date(now - 30_000),
    })

    await expect(getWorkerHeartbeatStatus('worker-a', now)).resolves.toMatchObject({
      healthy: true,
      workerId: 'worker-a',
      status: 'IDLE',
      ageSeconds: 30,
    })

    mocks.worker.findUnique.mockResolvedValue({
      workerId: 'worker-a',
      status: 'IDLE',
      lastSeenAt: new Date(now - 120_000),
    })
    await expect(getWorkerHeartbeatStatus('worker-a', now)).resolves.toMatchObject({
      healthy: false,
      reason: 'stale',
    })
  })

  test('does not report old worker registrations as a blocker while a worker is responsive', () => {
    expect(summarizeWorkerAttention([
      { workerId: 'current', status: 'IDLE' },
      { workerId: 'old', status: 'STALE' },
    ])).toBeNull()
  })

  test('reports a failed responsive worker or the absence of a heartbeat', () => {
    expect(summarizeWorkerAttention([{ workerId: 'current', status: 'DEGRADED' }])).toEqual({ kind: 'degraded', workers: [{ workerId: 'current', status: 'DEGRADED' }] })
    expect(summarizeWorkerAttention([{ workerId: 'old', status: 'STALE' }])).toEqual({ kind: 'stale', workers: [{ workerId: 'old', status: 'STALE' }] })
    expect(summarizeWorkerAttention([])).toEqual({ kind: 'unavailable', workers: [] })
  })

  test('reports a fresh running task lease when worker registrations are stale', () => {
    const now = Date.parse('2026-10-19T06:12:30.000Z')
    expect(summarizeWorkerAttention(
      [{ workerId: 'old', status: 'STALE' }],
      [{ status: 'RUNNING', leaseHeartbeatAt: '2026-10-19T06:12:19.000Z' }],
      now,
    )).toEqual({ kind: 'active-task', workers: [{ workerId: 'old', status: 'STALE' }], activeTaskCount: 1 })
  })

  test('keeps queued work visible even when another task has a fresh lease', () => {
    const now = Date.parse('2026-10-19T06:12:30.000Z')
    expect(summarizeWorkerAttention(
      [{ workerId: 'old', status: 'STALE' }],
      [
        { status: 'RUNNING', leaseHeartbeatAt: '2026-10-19T06:12:19.000Z' },
        { status: 'QUEUED', leaseHeartbeatAt: null },
        { status: 'AWAITING_APPROVAL', leaseHeartbeatAt: null },
      ],
      now,
    )).toEqual({ kind: 'queued-with-active-task', workers: [{ workerId: 'old', status: 'STALE' }], activeTaskCount: 1, queuedTaskCount: 1 })
  })

  test('does not treat an old lease or approval-only task as active work', () => {
    const now = Date.parse('2026-10-19T06:12:30.000Z')
    expect(summarizeWorkerAttention(
      [{ workerId: 'old', status: 'STALE' }],
      [
        { status: 'RUNNING', leaseHeartbeatAt: '2026-10-19T06:09:59.000Z' },
        { status: 'AWAITING_APPROVAL', leaseHeartbeatAt: null },
      ],
      now,
    )).toEqual({ kind: 'stale', workers: [{ workerId: 'old', status: 'STALE' }] })
  })

  test('keeps queued tasks visible when every registered worker is stale', () => {
    expect(summarizeWorkerAttention(
      [{ workerId: 'old', status: 'STALE' }],
      [{ status: 'QUEUED', leaseHeartbeatAt: null }],
      Date.parse('2026-10-19T06:12:30.000Z'),
    )).toEqual({ kind: 'stale', workers: [{ workerId: 'old', status: 'STALE' }], queuedTaskCount: 1 })
  })
})

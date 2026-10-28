/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  internal: vi.fn(),
  getWorkerHeartbeatStatus: vi.fn(),
}))

vi.mock('@/lib/session', () => ({ isInternalRequest: mocks.internal }))
vi.mock('@/lib/reamon/worker-health', () => ({ getWorkerHeartbeatStatus: mocks.getWorkerHeartbeatStatus }))

import { GET } from './route'

function request(workerId: string) {
  return new NextRequest(`http://localhost/api/internal/reamon/workers/health?workerId=${encodeURIComponent(workerId)}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.internal.mockReturnValue(true)
  mocks.getWorkerHeartbeatStatus.mockResolvedValue({ healthy: true, workerId: 'worker-a', status: 'IDLE', lastSeenAt: '2026-10-28T12:00:00.000Z', ageSeconds: 1 })
})

describe('GET /api/internal/reamon/workers/health', () => {
  test('requires the internal worker key', async () => {
    mocks.internal.mockReturnValue(false)

    const response = await GET(request('worker-a') as never)

    expect(response.status).toBe(401)
    expect(mocks.getWorkerHeartbeatStatus).not.toHaveBeenCalled()
  })

  test('rejects malformed worker identifiers', async () => {
    const response = await GET(request('../worker') as never)

    expect(response.status).toBe(400)
    expect(mocks.getWorkerHeartbeatStatus).not.toHaveBeenCalled()
  })

  test('reports a fresh worker heartbeat as healthy without caching it', async () => {
    const response = await GET(request('worker-a') as never)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ healthy: true, workerId: 'worker-a', status: 'IDLE' })
    expect(mocks.getWorkerHeartbeatStatus).toHaveBeenCalledWith('worker-a')
  })

  test('returns unavailable for a stale heartbeat so Docker marks the worker unhealthy', async () => {
    mocks.getWorkerHeartbeatStatus.mockResolvedValue({ healthy: false, workerId: 'worker-a', reason: 'stale' })

    const response = await GET(request('worker-a') as never)

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ healthy: false, reason: 'stale' })
  })
})

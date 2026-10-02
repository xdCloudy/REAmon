/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn(), access: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ default: { $queryRaw: mocks.queryRaw } }))
vi.mock('node:fs/promises', () => ({ access: mocks.access }))
vi.mock('@/lib/reamon/artifact-storage', () => ({ artifactRoot: () => '/data/reamon-artifacts' }))

import { GET } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.queryRaw.mockResolvedValue([{ '?column?': 1 }])
  mocks.access.mockResolvedValue(undefined)
})

describe('GET /api/health/ready', () => {
  test('returns ready only when database and artifact storage are usable', async () => {
    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'ready',
      checks: { database: 'ok', artifacts: 'ok' },
    })
    expect(mocks.access).toHaveBeenCalledWith('/data/reamon-artifacts', expect.any(Number))
  })

  test('returns 503 when a dependency is unavailable', async () => {
    mocks.queryRaw.mockRejectedValueOnce(new Error('database offline'))

    const response = await GET()

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      status: 'not_ready',
      checks: { database: 'unavailable', artifacts: 'ok' },
    })
  })
})

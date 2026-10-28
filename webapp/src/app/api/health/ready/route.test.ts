/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn(), access: vi.fn(), verifyGraphConnection: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ default: { $queryRaw: mocks.queryRaw } }))
vi.mock('node:fs/promises', () => ({ access: mocks.access }))
vi.mock('@/lib/reamon/artifact-storage', () => ({ artifactRoot: () => '/data/reamon-artifacts' }))
vi.mock('@/app/api/graph/neo4j', () => ({ verifyConnection: mocks.verifyGraphConnection }))

import { GET } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.queryRaw.mockResolvedValue([{ '?column?': 1 }])
  mocks.access.mockResolvedValue(undefined)
  mocks.verifyGraphConnection.mockResolvedValue(true)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/health/ready', () => {
  test('returns ready only when Postgres, Neo4j, and artifact storage are usable', async () => {
    const response = await GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'ready',
      checks: { database: 'ok', neo4j: 'ok', artifacts: 'ok' },
      build: { revision: 'unknown', dirty: null },
    })
    expect(mocks.access).toHaveBeenCalledWith('/data/reamon-artifacts', expect.any(Number))
  })

  test('returns 503 when a dependency is unavailable', async () => {
    mocks.queryRaw.mockRejectedValueOnce(new Error('database offline'))

    const response = await GET()

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      status: 'not_ready',
      checks: { database: 'unavailable', neo4j: 'ok', artifacts: 'ok' },
      build: { revision: 'unknown', dirty: null },
    })
  })

  test('returns not ready when Neo4j is running but rejects configured credentials', async () => {
    mocks.verifyGraphConnection.mockResolvedValueOnce(false)

    const response = await GET()

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      status: 'not_ready',
      checks: { database: 'ok', neo4j: 'unavailable', artifacts: 'ok' },
    })
  })

  test('reports the baked source revision and dirty state', async () => {
    vi.stubEnv('REAMON_BUILD_SHA', 'abc123def456')
    vi.stubEnv('REAMON_BUILD_DIRTY', 'true')

    const response = await GET()

    await expect(response.json()).resolves.toMatchObject({
      build: { revision: 'abc123def456', dirty: true },
    })
  })
})

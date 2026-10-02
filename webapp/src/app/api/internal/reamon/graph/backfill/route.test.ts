/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ internal: vi.fn(), findMany: vi.fn() }))
vi.mock('@/lib/session', () => ({ isInternalRequest: mocks.internal }))
vi.mock('@/lib/prisma', () => ({ default: { project: { findMany: mocks.findMany } } }))

import { POST } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.internal.mockReturnValue(true)
  mocks.findMany.mockResolvedValue([{ id: 'project-1' }, { id: 'project-2' }])
})

describe('POST /api/internal/reamon/graph/backfill', () => {
  test('lists projects with normalized observations in a bounded page', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ limit: 20, offset: 4 }),
      headers: { 'Content-Type': 'application/json' },
    }) as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ offset: 4, projects: ['project-1', 'project-2'], truncated: false, nextOffset: null })
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { observations: { some: {} } },
      orderBy: { id: 'asc' },
      skip: 4,
      take: 11,
      select: { id: true },
    })
  })

  test('requires internal authentication and rejects invalid pagination', async () => {
    mocks.internal.mockReturnValue(false)
    await expect(POST(new Request('http://localhost', { method: 'POST' }) as never)).resolves.toMatchObject({ status: 401 })
    mocks.internal.mockReturnValue(true)
    const response = await POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ limit: 0 }) }) as never)
    expect(response.status).toBe(400)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })
})

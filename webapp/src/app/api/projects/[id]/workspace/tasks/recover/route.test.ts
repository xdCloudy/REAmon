/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  recoverStaleAnalysisTasks: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))
vi.mock('@/lib/reamon/task-control', () => ({ recoverStaleAnalysisTasks: mocks.recoverStaleAnalysisTasks }))

import { POST } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1' } })
  mocks.recoverStaleAnalysisTasks.mockResolvedValue({ recovered: 2, staleAfterMinutes: 30, cutoff: '2026-10-02T12:00:00.000Z' })
})

describe('POST /api/projects/[id]/workspace/tasks/recover', () => {
  test('enforces project access before recovery', async () => {
    mocks.requireProjectAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))

    const response = await POST(new Request('http://localhost', { method: 'POST' }), params)

    expect(response.status).toBe(404)
    expect(mocks.recoverStaleAnalysisTasks).not.toHaveBeenCalled()
  })

  test('recovers stale tasks using the requested lease window', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ staleAfterMinutes: 45 }),
      headers: { 'Content-Type': 'application/json' },
    }), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ recovered: 2, staleAfterMinutes: 30 })
    expect(mocks.recoverStaleAnalysisTasks).toHaveBeenCalledWith('project-1', 45)
  })

  test('rejects an invalid recovery window', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ staleAfterMinutes: '45' }),
    }), params)

    expect(response.status).toBe(400)
    expect(mocks.recoverStaleAnalysisTasks).not.toHaveBeenCalled()
  })
})

/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mockRequireAdmin = vi.fn()
const mockAgentFetch = vi.fn()

vi.mock('@/lib/session', () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}))
vi.mock('@/lib/agentFetch', () => ({
  agentFetch: (...args: unknown[]) => mockAgentFetch(...args),
}))

import { GET as listSessions } from './sessions/route'
import { POST as interactWithSession } from './sessions/[id]/interact/route'
import { POST as killSession } from './sessions/[id]/kill/route'
import { POST as killJob } from './jobs/[id]/kill/route'

const unauthorized = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
const forbidden = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
const admin = { userId: 'admin-user', role: 'admin' }
const params = (id: string) => ({ params: Promise.resolve({ id }) })

const cases = [
  {
    name: 'list sessions',
    invoke: () => listSessions(),
    expectedPath: '/sessions',
    expectedInit: { cache: 'no-store' },
  },
  {
    name: 'interact with session',
    invoke: () => interactWithSession(
      new NextRequest('http://x/api/agent/sessions/s-1/interact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'status' }),
      }),
      params('s-1'),
    ),
    expectedPath: '/sessions/s-1/interact',
    expectedInit: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'status' }),
    },
  },
  {
    name: 'kill session',
    invoke: () => killSession(
      new NextRequest('http://x/api/agent/sessions/s-1/kill', { method: 'POST' }),
      params('s-1'),
    ),
    expectedPath: '/sessions/s-1/kill',
    expectedInit: { method: 'POST' },
  },
  {
    name: 'kill job',
    invoke: () => killJob(
      new NextRequest('http://x/api/agent/jobs/j-1/kill', { method: 'POST' }),
      params('j-1'),
    ),
    expectedPath: '/jobs/j-1/kill',
    expectedInit: { method: 'POST' },
  },
]

beforeEach(() => {
  mockRequireAdmin.mockReset()
  mockAgentFetch.mockReset().mockResolvedValue(Response.json({ ok: true }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('shared agent session and job controls require admin', () => {
  for (const route of cases) {
    test(`${route.name}: unauthenticated request gets 401 without proxying`, async () => {
      mockRequireAdmin.mockResolvedValue(unauthorized)

      const response = await route.invoke()

      expect(response.status).toBe(401)
      expect(mockAgentFetch).not.toHaveBeenCalled()
    })

    test(`${route.name}: standard user gets 403 without proxying`, async () => {
      mockRequireAdmin.mockResolvedValue(forbidden)

      const response = await route.invoke()

      expect(response.status).toBe(403)
      expect(mockAgentFetch).not.toHaveBeenCalled()
    })

    test(`${route.name}: admin reaches the intended agent endpoint`, async () => {
      mockRequireAdmin.mockResolvedValue(admin)

      const response = await route.invoke()

      expect(response.status).toBe(200)
      expect(mockAgentFetch).toHaveBeenCalledWith(route.expectedPath, route.expectedInit)
      expect(await response.json()).toEqual({ ok: true })
    })
  }
})

/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mockRequireAdmin = vi.fn()
const mockGuardProjectStrict = vi.fn()
const mockAgentFetch = vi.fn()

vi.mock('@/lib/session', () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}))
vi.mock('@/lib/access', () => ({
  guardProjectStrict: (...args: unknown[]) => mockGuardProjectStrict(...args),
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
const projectId = 'project-1'
const params = (id: string) => ({ params: Promise.resolve({ id }) })

const cases = [
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

const projectCases = [
  {
    name: 'list sessions',
    invoke: () => listSessions(new NextRequest(`http://x/api/agent/sessions?projectId=${projectId}`)),
    expectedPath: `/sessions?project_id=${projectId}`,
    expectedInit: { cache: 'no-store' },
  },
  {
    name: 'interact with session',
    invoke: () => interactWithSession(
      new NextRequest(`http://x/api/agent/sessions/s-1/interact?projectId=${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'status' }),
      }),
      params('s-1'),
    ),
    expectedPath: `/sessions/s-1/interact?project_id=${projectId}`,
    expectedInit: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'status', project_id: projectId }),
    },
  },
  {
    name: 'kill session',
    invoke: () => killSession(
      new NextRequest(`http://x/api/agent/sessions/s-1/kill?projectId=${projectId}`, { method: 'POST' }),
      params('s-1'),
    ),
    expectedPath: `/sessions/s-1/kill?project_id=${projectId}`,
    expectedInit: { method: 'POST' },
  },
]

beforeEach(() => {
  mockRequireAdmin.mockReset()
  mockGuardProjectStrict.mockReset().mockResolvedValue(null)
  mockAgentFetch.mockReset().mockResolvedValue(Response.json({ ok: true }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('global agent job controls require admin', () => {
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

describe('project session controls enforce strict project ownership', () => {
  for (const route of projectCases) {
    test(`${route.name}: inaccessible project is rejected before proxying`, async () => {
      mockGuardProjectStrict.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))

      const response = await route.invoke()

      expect(response.status).toBe(404)
      expect(mockGuardProjectStrict).toHaveBeenCalledWith(projectId)
      expect(mockAgentFetch).not.toHaveBeenCalled()
    })

    test(`${route.name}: project owner reaches only project-scoped API`, async () => {
      const response = await route.invoke()

      expect(response.status).toBe(200)
      expect(mockGuardProjectStrict).toHaveBeenCalledWith(projectId)
      expect(mockAgentFetch).toHaveBeenCalledWith(route.expectedPath, route.expectedInit)
      expect(await response.json()).toEqual({ ok: true })
    })
  }
})

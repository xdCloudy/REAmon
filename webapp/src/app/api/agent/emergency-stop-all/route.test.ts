/**
 * Emergency stop is a global control and must be restricted to administrators.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mockRequireAdmin = vi.fn()
const mockAgentFetch = vi.fn()

vi.mock('@/lib/session', () => ({
  requireAdmin: () => mockRequireAdmin(),
}))

vi.mock('@/lib/agentFetch', () => ({
  agentFetch: (...args: unknown[]) => mockAgentFetch(...args),
}))

import { POST } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAdmin.mockResolvedValue({ userId: 'admin-1', role: 'admin' })
  mockAgentFetch.mockResolvedValue(new Response(JSON.stringify({ stopped: 3 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
})

describe('POST /api/agent/emergency-stop-all', () => {
  test('standard user receives 403 without reaching the agent', async () => {
    mockRequireAdmin.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))

    const response = await POST()

    expect(response.status).toBe(403)
    expect(mockAgentFetch).not.toHaveBeenCalled()
  })

  test('admin reaches the authenticated agent proxy', async () => {
    const response = await POST()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ stopped: 3 })
    expect(mockAgentFetch).toHaveBeenCalledWith('/emergency-stop-all', { method: 'POST' })
  })
})

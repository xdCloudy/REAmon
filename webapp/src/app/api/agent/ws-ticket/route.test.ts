/**
 * Unit tests for POST /api/agent/ws-ticket — STRIDE S6.
 *
 * The ticket identity MUST come from the verified session cookie, never the
 * request body, so a caller cannot mint a ticket for another user. session +
 * auth are mocked.
 *
 * Run: npx vitest run "src/app/api/agent/ws-ticket/route.test.ts"
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mockGetEffectiveUser = vi.fn()
const mockRequireProjectAccessStrict = vi.fn()
const mockCreateWsTicket = vi.fn()

vi.mock('@/lib/session', () => ({
  getEffectiveUser: (...a: unknown[]) => mockGetEffectiveUser(...a),
}))
vi.mock('@/lib/access', () => ({
  requireProjectAccessStrict: (...a: unknown[]) => mockRequireProjectAccessStrict(...a),
}))
vi.mock('@/lib/auth', () => ({
  createWsTicket: (...a: unknown[]) => mockCreateWsTicket(...a),
}))

import { POST } from './route'

function req(body: unknown): NextRequest {
  return new NextRequest('http://x/api/agent/ws-ticket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 })

beforeEach(() => {
  mockGetEffectiveUser.mockReset()
  mockRequireProjectAccessStrict.mockReset().mockResolvedValue({ project: { id: 'p', userId: 'real-user' } })
  mockCreateWsTicket.mockReset().mockResolvedValue('signed.ticket.value')
})

describe('POST /api/agent/ws-ticket — S6 + impersonation', () => {
  test('no session → 401, no ticket minted', async () => {
    mockGetEffectiveUser.mockResolvedValue(null)
    const res = await POST(req({ projectId: 'p', sessionId: 's' }))
    expect(res.status).toBe(401)
    expect(mockCreateWsTicket).not.toHaveBeenCalled()
  })

  test('missing projectId/sessionId → 400', async () => {
    mockGetEffectiveUser.mockResolvedValue({ userId: 'u1' })
    expect((await POST(req({ projectId: 'p' }))).status).toBe(400)
    expect((await POST(req({ sessionId: 's' }))).status).toBe(400)
  })

  test('identity is bound to the EFFECTIVE user, never the body', async () => {
    mockGetEffectiveUser.mockResolvedValue({ userId: 'real-user' })
    // Attacker tries to smuggle a different userId in the body.
    const res = await POST(req({ userId: 'victim', projectId: 'p', sessionId: 's' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ticket: 'signed.ticket.value' })
    expect(mockCreateWsTicket).toHaveBeenCalledWith('real-user', 'p', 's')
  })

  test('admin simulating X → ticket minted for X (impersonation-consistent)', async () => {
    mockGetEffectiveUser.mockResolvedValue({ userId: 'user-X' })
    mockRequireProjectAccessStrict.mockResolvedValue({ project: { id: 'p', userId: 'user-X' } })
    const res = await POST(req({ projectId: 'p', sessionId: 's' }))
    expect(res.status).toBe(200)
    expect(mockCreateWsTicket).toHaveBeenCalledWith('user-X', 'p', 's')
  })

  test('EXPLOIT: minting a ticket for a project the effective user does not own → blocked, no ticket', async () => {
    mockGetEffectiveUser.mockResolvedValue({ userId: 'attacker' })
    mockRequireProjectAccessStrict.mockResolvedValue(NOT_FOUND)
    const res = await POST(req({ projectId: 'victimProj', sessionId: 's' }))
    expect(res.status).toBe(404)
    expect(mockCreateWsTicket).not.toHaveBeenCalled()
  })

  test('null ticket (secret unset) is passed through; the WebSocket handshake fails closed', async () => {
    mockGetEffectiveUser.mockResolvedValue({ userId: 'u1' })
    mockCreateWsTicket.mockResolvedValue(null)
    const res = await POST(req({ projectId: 'p', sessionId: 's' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ticket: null })
  })
})

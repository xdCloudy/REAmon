/**
 * DELETE must keep saved MCP credentials out of the API response while
 * preserving the raw configuration for storage and the agent reload.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockFindUnique = vi.fn()
const mockUpdate = vi.fn()

vi.mock('@/lib/prisma', () => ({
  default: {
    userSettings: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}))

vi.mock('@/lib/session', () => ({
  requireUserAccess: vi.fn().mockResolvedValue(null),
}))

import { DELETE } from './route'

const servers = [
  {
    id: 'keep',
    name: 'Private MCP',
    transport: 'streamable_http',
    url: 'https://mcp.example.test',
    auth: { type: 'bearer', token: 'bearer-secret-value' },
    headers: { 'X-Private': 'header-secret-value' },
    env: { PRIVATE_KEY: 'environment-secret-value' },
  },
  {
    id: 'delete',
    name: 'Remove me',
    transport: 'streamable_http',
    url: 'https://remove.example.test',
  },
]

function request() {
  return new NextRequest('http://localhost/api/users/user-1/mcp/delete', { method: 'DELETE' })
}

const params = { params: Promise.resolve({ id: 'user-1', serverId: 'delete' }) }

describe('DELETE /api/users/[id]/mcp/[serverId]', () => {
  beforeEach(() => {
    mockFindUnique.mockReset().mockResolvedValue({ mcpServers: servers })
    mockUpdate.mockReset().mockResolvedValue({})
  })

  test('masks retained secrets in the response but persists and reloads raw config', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await DELETE(request(), params)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.servers[0].auth.token).toBe('••••••••alue')
    expect(body.servers[0].headers['X-Private']).toBe('••••••••alue')
    expect(body.servers[0].env.PRIVATE_KEY).toBe('••••••••alue')
    expect(JSON.stringify(body)).not.toContain('secret-value')

    const retained = [servers[0]]
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { mcpServers: retained },
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const reload = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(reload.body as string)).toEqual({ userMcpServers: retained })
  })
})

/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

const fetchMock = vi.fn()

vi.mock('@/lib/agentAuth', () => ({
  internalKeyHeaders: (headers: Record<string, string> = {}) => ({ ...headers, 'x-internal-key': 'test-key' }),
}))

import { POST } from './route'

function request(body: unknown): NextRequest {
  return new NextRequest('http://rea.test/api/mcp/reload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue({ status: 200, json: async () => ({ ok: true }) })
})

describe('POST /api/mcp/reload', () => {
  test('rejects stdio servers before proxying to the shared agent', async () => {
    const response = await POST(request({ userMcpServers: [
      { id: 'unsafe', transport: 'stdio', command: 'node', args: ['-e', 'process.exit(0)'] },
    ] }))

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('preserves HTTP MCP reloads', async () => {
    const servers = [{ id: 'remote', transport: 'streamable_http', url: 'https://mcp.example.test/mcp' }]
    const response = await POST(request({ userMcpServers: servers }))

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ userMcpServers: servers })
    expect(init.headers['x-internal-key']).toBe('test-key')
  })
})

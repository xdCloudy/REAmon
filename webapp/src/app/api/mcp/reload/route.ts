/** POST /api/mcp/reload - manual reload trigger; proxies to agent. */
import { NextRequest, NextResponse } from 'next/server'
import { internalKeyHeaders } from '@/lib/agentAuth'

const AGENT_API_URL = process.env.AGENT_API_URL || 'http://agent:8080'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const userMcpServers = body && typeof body === 'object' && 'userMcpServers' in body
      ? (body as { userMcpServers?: unknown }).userMcpServers
      : undefined
    if (Array.isArray(userMcpServers) && userMcpServers.some(
      server => server && typeof server === 'object' && 'transport' in server && server.transport === 'stdio',
    )) {
      return NextResponse.json(
        { error: 'stdio MCP servers are disabled until they can run in an isolated per-user worker' },
        { status: 400 },
      )
    }
    const upstream = await fetch(`${AGENT_API_URL}/mcp/reload`, {
      method: 'POST',
      headers: internalKeyHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const data = await upstream.json().catch(() => ({}))
    return NextResponse.json(data, { status: upstream.status })
  } catch (error) {
    console.error('Failed to proxy /mcp/reload:', error)
    return NextResponse.json({ error: 'agent unreachable' }, { status: 502 })
  }
}

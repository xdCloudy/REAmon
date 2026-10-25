/**
 * PUT    /api/users/[id]/mcp/[serverId] - update one server
 * DELETE /api/users/[id]/mcp/[serverId] - delete one server
 *
 * Both fire async POST ${AGENT_API_URL}/mcp/reload after a successful write.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireUserAccess } from '@/lib/session'
import prisma from '@/lib/prisma'
import { mcpServerSchema, validateMcpServers, type MCPServer } from '@/lib/mcp/schema'
import { maskMcpServersForApi, restoreMaskedToken } from '../route'
import { internalKeyHeaders } from '@/lib/agentAuth'

const AGENT_API_URL = process.env.AGENT_API_URL || 'http://agent:8080'

interface RouteParams {
  params: Promise<{ id: string; serverId: string }>
}

async function fireReload(userMcpServers: unknown) {
  try {
    await fetch(`${AGENT_API_URL}/mcp/reload`, {
      method: 'POST',
      headers: internalKeyHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ userMcpServers }),
    })
  } catch (e) {
    console.warn('Failed to ping agent /mcp/reload:', e)
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { id, serverId } = await params
    const __denied = await requireUserAccess(request, id)
    if (__denied) return __denied
    const body = await request.json()

    // Look up the existing record first so we can restore the literal auth
    // token if the user submitted a masked placeholder. This must happen
    // BEFORE schema validation so the at-least-one auth refine sees the
    // restored token, not the placeholder.
    const existing = await prisma.userSettings.findUnique({
      where: { userId: id },
      select: { mcpServers: true },
    })
    const current = (Array.isArray(existing?.mcpServers) ? existing!.mcpServers : []) as MCPServer[]
    const existingServer = current.find(s => s.id === serverId)

    // Restore masked token (••••...) from the existing DB record.
    const restored = existingServer
      ? restoreMaskedToken(body as MCPServer, existingServer)
      : (body as MCPServer)

    const parsed = mcpServerSchema.safeParse(restored)
    if (!parsed.success) {
      return NextResponse.json({
        error: 'invalid MCP server',
        issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      }, { status: 400 })
    }
    const updated: MCPServer = parsed.data

    if (updated.id !== serverId) {
      return NextResponse.json({ error: 'server id in path does not match body id' }, { status: 400 })
    }

    const idx = current.findIndex((s) => s.id === serverId)
    if (idx === -1) {
      return NextResponse.json({ error: `server '${serverId}' not found` }, { status: 404 })
    }

    const next = [...current]
    next[idx] = updated

    const { valid, errors } = validateMcpServers(next)
    if (errors.length > 0 || valid.length !== next.length) {
      return NextResponse.json({ error: 'cross-server validation failed', issues: errors }, { status: 400 })
    }

    await prisma.userSettings.update({
      where: { userId: id },
      data: { mcpServers: next as unknown as object },
    })

    void fireReload(next)
    const [returned] = maskMcpServersForApi([updated])
    return NextResponse.json({ server: returned, servers: maskMcpServersForApi(next) })
  } catch (error) {
    console.error('Failed to update MCP server:', error)
    return NextResponse.json({ error: 'Failed to update MCP server' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id, serverId } = await params
    const __denied = await requireUserAccess(request, id)
    if (__denied) return __denied

    const existing = await prisma.userSettings.findUnique({
      where: { userId: id },
      select: { mcpServers: true },
    })
    const current = (Array.isArray(existing?.mcpServers) ? existing!.mcpServers : []) as MCPServer[]

    const next = current.filter((s) => s.id !== serverId)
    if (next.length === current.length) {
      return NextResponse.json({ error: `server '${serverId}' not found` }, { status: 404 })
    }

    await prisma.userSettings.update({
      where: { userId: id },
      data: { mcpServers: next as unknown as object },
    })

    void fireReload(next)
    return NextResponse.json({ servers: maskMcpServersForApi(next) })
  } catch (error) {
    console.error('Failed to delete MCP server:', error)
    return NextResponse.json({ error: 'Failed to delete MCP server' }, { status: 500 })
  }
}

/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  assertProject: vi.fn(),
  getSummary: vi.fn(),
}))

vi.mock('@/lib/mcpAuth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mcpAuth')>('@/lib/mcpAuth')
  return { ...actual, assertMcpProjectAccess: (...args: unknown[]) => h.assertProject(...args) }
})
vi.mock('@/lib/reamon/inventory-summary', () => ({
  getWorkspaceInventorySummary: (...args: unknown[]) => h.getSummary(...args),
}))

import { McpScopeError, __resetRateLimiter } from '@/lib/mcpAuth'
import { getWorkspaceSummary } from './workspaceSummaryTools'
import type { McpContext } from './tools'

const ctx = (scopes: string[] = ['recon:read']): McpContext => ({
  token: {
    tokenId: 'token-1', userId: 'owner', tokenPrefix: 'rdmn_mcp_aaaaaaaa',
    name: 'agent', scopes: scopes as never,
  },
})

beforeEach(() => {
  vi.clearAllMocks()
  __resetRateLimiter()
  h.getSummary.mockResolvedValue({
    projectId: 'project-1', rootCount: 1, counts: { files: 1 }, capabilities: [], progress: { overallPercent: 0, metrics: [] },
  })
})

describe('REAmon workspace summary MCP tool', () => {
  test('checks ownership before querying deterministic stored summary state', async () => {
    const result = await getWorkspaceSummary(ctx(), 'project-1')

    expect(result).toMatchObject({ projectId: 'project-1', rootCount: 1 })
    expect(h.assertProject).toHaveBeenCalledWith('owner', 'project-1')
    expect(h.getSummary).toHaveBeenCalledWith('project-1')
  })

  test('requires the existing read scope before project access', async () => {
    await expect(getWorkspaceSummary(ctx([]), 'project-1')).rejects.toBeInstanceOf(McpScopeError)
    expect(h.assertProject).not.toHaveBeenCalled()
    expect(h.getSummary).not.toHaveBeenCalled()
  })

  test('reports a missing workspace instead of returning an empty summary', async () => {
    h.getSummary.mockResolvedValue(null)
    await expect(getWorkspaceSummary(ctx(), 'missing'))
      .rejects.toMatchObject({ code: 'not_found' })
    expect(h.assertProject).toHaveBeenCalledWith('owner', 'missing')
  })
})


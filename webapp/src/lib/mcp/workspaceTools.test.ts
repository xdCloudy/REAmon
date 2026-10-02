/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  assertProject: vi.fn(),
  listFiles: vi.fn(),
  getArtifact: vi.fn(),
}))

vi.mock('@/lib/mcpAuth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mcpAuth')>('@/lib/mcpAuth')
  return {
    ...actual,
    assertMcpProjectAccess: (...args: unknown[]) => h.assertProject(...args),
  }
})
vi.mock('@/lib/reamon/inventory-query', () => ({
  listWorkspaceFiles: (...args: unknown[]) => h.listFiles(...args),
  getWorkspaceArtifact: (...args: unknown[]) => h.getArtifact(...args),
}))

import { McpScopeError, __resetRateLimiter } from '@/lib/mcpAuth'
import { getWorkspaceArtifact, listWorkspaceInventory } from './workspaceTools'
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
  h.listFiles.mockResolvedValue({ artifacts: [], total: 0, limit: 100, offset: 0, hasMore: false })
  h.getArtifact.mockResolvedValue({ id: 'artifact-1', relativePath: 'bin/app.exe', capabilities: [] })
})

describe('REAmon workspace MCP tools', () => {
  test('lists only an authorized project through the logical inventory service', async () => {
    const result = await listWorkspaceInventory(ctx(), {
      projectId: 'project-1', search: 'crypto', format: 'PE', kind: 'executables', limit: 25, offset: 50,
    })

    expect(result).toMatchObject({ projectId: 'project-1', total: 0 })
    expect(h.assertProject).toHaveBeenCalledWith('owner', 'project-1')
    expect(h.listFiles).toHaveBeenCalledWith('project-1', {
      search: 'crypto', format: 'PE', kind: 'executables', limit: 25, offset: 50,
    })
  })

  test('requires the existing read scope', async () => {
    await expect(listWorkspaceInventory(ctx([]), { projectId: 'project-1' }))
      .rejects.toBeInstanceOf(McpScopeError)
    expect(h.assertProject).not.toHaveBeenCalled()
    expect(h.listFiles).not.toHaveBeenCalled()
  })

  test('gets one logical artifact only after project ownership is checked', async () => {
    const result = await getWorkspaceArtifact(ctx(), { projectId: 'project-1', artifactId: 'artifact-1' })

    expect(result).toMatchObject({ projectId: 'project-1', artifact: { relativePath: 'bin/app.exe' } })
    expect(h.assertProject).toHaveBeenCalledWith('owner', 'project-1')
    expect(h.getArtifact).toHaveBeenCalledWith('project-1', 'artifact-1')
  })

  test('does not turn an absent or historical artifact into an empty success', async () => {
    h.getArtifact.mockResolvedValue(null)
    await expect(getWorkspaceArtifact(ctx(), { projectId: 'project-1', artifactId: 'old' }))
      .rejects.toMatchObject({ code: 'not_found' })
  })
})

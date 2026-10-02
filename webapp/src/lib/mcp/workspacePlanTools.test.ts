/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  assertProject: vi.fn(),
  listFiles: vi.fn(),
}))

vi.mock('@/lib/mcpAuth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mcpAuth')>('@/lib/mcpAuth')
  return { ...actual, assertMcpProjectAccess: (...args: unknown[]) => h.assertProject(...args) }
})
vi.mock('@/lib/reamon/inventory-query', () => ({
  listWorkspaceFiles: (...args: unknown[]) => h.listFiles(...args),
}))

import { McpScopeError, __resetRateLimiter } from '@/lib/mcpAuth'
import { planWorkspaceAnalysis } from './workspacePlanTools'
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
  h.listFiles.mockResolvedValue({
    artifacts: [{
      id: 'artifact-1', name: 'app.exe', relativePath: 'bin/app.exe', parentPath: 'bin',
      targetId: null, importId: 'import-1', sizeBytes: 1, sha256: 'hash', extension: 'exe',
      status: 'IDENTIFIED', profile: { format: 'pe' }, capabilities: [{
        pluginId: 'profiler', pluginName: 'Profiler', category: 'profiling', integration: 'native',
        acceptsTargetTypes: ['FILE'], acceptsFormats: ['*'],
        capabilities: ['identify'], produces: [], requirements: [],
      }],
    }],
    total: 1, limit: 100, offset: 0, hasMore: false,
  })
})

describe('REAmon workspace analysis planning MCP tool', () => {
  test('checks ownership and delegates bounded inventory filters', async () => {
    const result = await planWorkspaceAnalysis(ctx(), {
      projectId: 'project-1', kind: 'executables', capability: 'identify', limit: 25, offset: 50,
    })

    expect(result).toMatchObject({
      projectId: 'project-1', requestedCapability: 'identify', proposedSteps: 1,
      steps: [expect.objectContaining({ relativePath: 'bin/app.exe', status: 'PROPOSED' })],
    })
    expect(h.assertProject).toHaveBeenCalledWith('owner', 'project-1')
    expect(h.listFiles).toHaveBeenCalledWith('project-1', {
      search: undefined, format: undefined, kind: 'executables', limit: 25, offset: 50,
    })
  })

  test('requires the existing read scope before checking project access', async () => {
    await expect(planWorkspaceAnalysis(ctx([]), { projectId: 'project-1' }))
      .rejects.toBeInstanceOf(McpScopeError)
    expect(h.assertProject).not.toHaveBeenCalled()
    expect(h.listFiles).not.toHaveBeenCalled()
  })
})

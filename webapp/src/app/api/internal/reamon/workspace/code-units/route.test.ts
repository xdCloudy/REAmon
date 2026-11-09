/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { signTag } from '@/lib/redamonCtx'
import { McpToolError } from '@/lib/mcp/errors'

const mocks = vi.hoisted(() => ({
  internal: vi.fn(),
  projectFindFirst: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  listRelationships: vi.fn(),
}))

vi.mock('@/lib/session', () => ({ isInternalRequest: mocks.internal }))
vi.mock('@/lib/prisma', () => ({ default: { project: { findFirst: mocks.projectFindFirst } } }))
vi.mock('@/lib/mcp/workspaceCodeTools', () => ({
  listWorkspaceCodeUnits: mocks.list,
  getWorkspaceCodeUnit: mocks.get,
  listWorkspaceCodeRelationships: mocks.listRelationships,
}))

import { POST } from './route'

const token = (tool = 'workspace_list_code_units', patch: Record<string, unknown> = {}) => signTag({
  source: 'agent', project_id: 'project-1', user_id: 'owner-1', tool, exp: Math.floor(Date.now() / 1000) + 120, ...patch,
}, 'internal-key')
const request = (body: unknown, tag = token()) => new Request('http://localhost', {
  method: 'POST', headers: { 'x-redamon-ctx': tag, 'content-type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INTERNAL_API_KEY = 'internal-key'
  mocks.internal.mockReturnValue(true)
  mocks.projectFindFirst.mockResolvedValue({ id: 'project-1' })
  mocks.list.mockResolvedValue({ codeUnits: [{ id: 'unit-1' }], total: 1 })
  mocks.get.mockResolvedValue({ id: 'unit-1', code: { sourceHash: 'a'.repeat(64) } })
  mocks.listRelationships.mockResolvedValue({ relationships: [], total: 0, nextCursor: null })
})

describe('POST /api/internal/reamon/workspace/code-units', () => {
  test('requires internal transport authentication and signed agent context', async () => {
    mocks.internal.mockReturnValue(false)
    expect((await POST(request({ tool: 'workspace_list_code_units' }) as never)).status).toBe(401)
    mocks.internal.mockReturnValue(true)
    expect((await POST(request({ tool: 'workspace_list_code_units' }, 'bad') as never)).status).toBe(401)
    expect(mocks.projectFindFirst).not.toHaveBeenCalled()
  })

  test('derives owner and project from the signed context and returns persisted index rows', async () => {
    const response = await POST(request({ tool: 'workspace_list_code_units', search: 'main', limit: 5 }) as never)
    expect(response.status).toBe(200)
    expect(mocks.projectFindFirst).toHaveBeenCalledWith({ where: { id: 'project-1', userId: 'owner-1' }, select: { id: true } })
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ token: expect.objectContaining({ userId: 'owner-1', scopes: ['recon:read'] }) }), { projectId: 'project-1', search: 'main', limit: 5 })
  })

  test('rejects mismatched tools, unsupported arguments, and projects not owned by the signer', async () => {
    expect((await POST(request({ tool: 'workspace_get_code_unit', codeUnitId: 'unit-1' }) as never)).status).toBe(403)
    expect((await POST(request({ tool: 'workspace_list_code_units', projectId: 'attacker' }) as never)).status).toBe(400)
    mocks.projectFindFirst.mockResolvedValue(null)
    expect((await POST(request({ tool: 'workspace_list_code_units' }) as never)).status).toBe(404)
    expect(mocks.list).not.toHaveBeenCalled()
  })

  test('bounds list paging and source detail offsets before invoking readers', async () => {
    expect((await POST(request({ tool: 'workspace_list_code_units', limit: 101 }) as never)).status).toBe(400)
    expect((await POST(request({ tool: 'workspace_list_code_units', cursor: 'too-long', offset: 1 }) as never)).status).toBe(400)
    const cursor = Buffer.from(JSON.stringify({ version: 1 })).toString('base64url')
    const paged = await POST(request({ tool: 'workspace_list_code_units', cursor }) as never)
    expect(paged.status).toBe(200)
    expect(mocks.list).toHaveBeenCalledWith(expect.any(Object), { projectId: 'project-1', cursor })
    expect((await POST(request({ tool: 'workspace_get_code_unit', codeUnitId: 'unit-1', sourceOffsetBytes: -1 }, token('workspace_get_code_unit')) as never)).status).toBe(400)
    expect((await POST(request({ tool: 'workspace_get_code_unit', codeUnitId: 'unit-1', sourceSnapshotHash: 'bad' }, token('workspace_get_code_unit')) as never)).status).toBe(400)
    expect(mocks.list).toHaveBeenCalledTimes(1)
    expect(mocks.get).not.toHaveBeenCalled()
  })

  test('delegates hash-bounded code detail reads and returns service errors distinctly', async () => {
    const sourceSnapshotHash = 'a'.repeat(64)
    const response = await POST(request({ tool: 'workspace_get_code_unit', codeUnitId: 'unit-1', sourceOffsetBytes: 128, sourceSnapshotHash }, token('workspace_get_code_unit')) as never)
    expect(response.status).toBe(200)
    expect(mocks.get).toHaveBeenCalledWith(expect.objectContaining({ token: expect.any(Object) }), { projectId: 'project-1', codeUnitId: 'unit-1', sourceOffsetBytes: 128, sourceSnapshotHash })
    mocks.get.mockRejectedValueOnce(new McpToolError('Code-unit sources changed while paging.', 'stale_source'))
    const stale = await POST(request({ tool: 'workspace_get_code_unit', codeUnitId: 'unit-1', sourceOffsetBytes: 128, sourceSnapshotHash }, token('workspace_get_code_unit')) as never)
    expect(stale.status).toBe(409)
  })

  test('returns stale code-unit cursor conflicts as HTTP 409', async () => {
    mocks.list.mockRejectedValueOnce(new McpToolError('The code-unit index changed while paging. Restart with cursor omitted.', 'stale_snapshot'))
    const response = await POST(request({ tool: 'workspace_list_code_units', cursor: 'stable-cursor' }) as never)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'stale_snapshot' })
  })

  test('reports missing cursor signing configuration as HTTP 503', async () => {
    mocks.list.mockRejectedValueOnce(new McpToolError('Stable code-unit paging is unavailable because cursor signing is not configured.', 'cursor_unavailable'))
    const response = await POST(request({ tool: 'workspace_list_code_units' }) as never)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'cursor_unavailable' })
  })

  test('delegates bounded relationship cursor reads under the signed agent context', async () => {
    const cursor = 'signed-relationship-cursor'
    const response = await POST(request({
      tool: 'workspace_list_code_relationships', codeUnitId: 'unit-1', relationshipKind: 'calls',
      direction: 'incoming', limit: 20, cursor,
    }, token('workspace_list_code_relationships')) as never)
    expect(response.status).toBe(200)
    expect(mocks.listRelationships).toHaveBeenCalledWith(
      expect.objectContaining({ token: expect.objectContaining({ userId: 'owner-1', scopes: ['recon:read'] }) }),
      { projectId: 'project-1', codeUnitId: 'unit-1', relationshipKind: 'calls', direction: 'incoming', limit: 20, cursor },
    )
    expect((await POST(request({
      tool: 'workspace_list_code_relationships', codeUnitId: 'unit-1', relationshipKind: 'calls',
      limit: 101,
    }, token('workspace_list_code_relationships')) as never)).status).toBe(400)
    expect((await POST(request({
      tool: 'workspace_list_code_relationships', codeUnitId: 'unit-1', relationshipKind: 'calls',
      offset: 1, cursor,
    }, token('workspace_list_code_relationships')) as never)).status).toBe(400)
  })
})

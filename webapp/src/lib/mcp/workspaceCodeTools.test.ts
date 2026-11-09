/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  assertProject: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
  selection: vi.fn(),
}))

vi.mock('@/lib/mcpAuth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mcpAuth')>('@/lib/mcpAuth')
  return { ...actual, assertMcpProjectAccess: (...args: unknown[]) => h.assertProject(...args) }
})
vi.mock('@/lib/prisma', () => ({
  default: { reamonObservation: {
    findMany: (...args: unknown[]) => h.findMany(...args),
    count: (...args: unknown[]) => h.count(...args),
    findFirst: (...args: unknown[]) => h.findFirst(...args),
  } },
}))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))

import { __resetRateLimiter } from '@/lib/mcpAuth'
import { listWorkspaceCodeUnits } from './workspaceCodeTools'
import type { McpContext } from './tools'

const ctx: McpContext = { token: {
  tokenId: 'token-1', userId: 'owner', tokenPrefix: 'rdmn_mcp_aaaaaaaa', name: 'agent', scopes: ['recon:read'],
} }
const row = (id: string, stableKey: string, updatedAt = new Date('2026-11-09T10:00:00.000Z')) => ({
  id, stableKey, type: 'code_unit', label: stableKey, source: 'provider-a', taskId: 'task-1', artifactId: 'artifact-1',
  updatedAt, attributes: { name: stableKey }, artifact: { relativePath: 'sample.bin', originalName: 'sample.bin', sha256: 'a'.repeat(64) },
})

beforeEach(() => {
  vi.clearAllMocks()
  __resetRateLimiter()
  h.selection.mockResolvedValue({ activeImportIds: new Set(['import-1']), artifactWhere: { projectId: 'project-1', importId: 'import-1' } })
  h.findMany.mockResolvedValue([])
  h.count.mockResolvedValue(0)
  h.findFirst.mockResolvedValue(null)
})

describe('workspace code-unit keyset paging', () => {
  test('returns a scope-bound cursor and advances by the stable key without offset', async () => {
    const timestamp = new Date('2026-11-09T10:00:00.000Z')
    h.findMany.mockResolvedValueOnce([row('unit-a', 'a', timestamp), row('unit-b', 'b', timestamp), row('unit-c', 'c', timestamp)])
    h.count.mockResolvedValueOnce(3)
    const first = await listWorkspaceCodeUnits(ctx, { projectId: 'project-1', taskId: 'task-1', search: 'Main', limit: 2 })
    expect(first).toMatchObject({ units: [{ id: 'unit-a' }, { id: 'unit-b' }], total: 3, hasMore: true, offset: 0 })
    expect(first.nextCursor).toEqual(expect.any(String))
    expect(h.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        projectId: 'project-1', taskId: 'task-1',
        createdAt: { lt: new Date(first.snapshotAt as string) },
        updatedAt: { lt: new Date(first.snapshotAt as string) },
      },
      orderBy: [{ stableKey: 'asc' }, { id: 'asc' }], take: 3, skip: 0,
    })

    h.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'unit-b', stableKey: 'b', updatedAt: timestamp })
    h.count.mockResolvedValueOnce(3)
    h.findMany.mockResolvedValueOnce([row('unit-c', 'c', timestamp)])
    const second = await listWorkspaceCodeUnits(ctx, {
      projectId: 'project-1', taskId: 'task-1', search: 'Main', limit: 2, cursor: first.nextCursor as string,
    })
    expect(second).toMatchObject({ units: [{ id: 'unit-c' }], total: 3, hasMore: false, nextCursor: null })
    expect(h.findMany.mock.calls[1][0].where).toMatchObject({
      taskId: 'task-1',
      OR: expect.any(Array),
      AND: [{ OR: [
        { stableKey: { gt: 'b' } },
        { stableKey: 'b', id: { gt: 'unit-b' } },
      ] }],
    })
    expect(h.findMany.mock.calls[1][0]).not.toHaveProperty('skip')
  })

  test('requires a restart if an item changes during a listing', async () => {
    h.findMany.mockResolvedValueOnce([row('unit-a', 'a'), row('unit-b', 'b')])
    h.count.mockResolvedValueOnce(2)
    const first = await listWorkspaceCodeUnits(ctx, { projectId: 'project-1', limit: 1 })
    h.findFirst.mockResolvedValueOnce({ id: 'unit-a' })
    h.count.mockResolvedValueOnce(2)
    await expect(listWorkspaceCodeUnits(ctx, { projectId: 'project-1', limit: 1, cursor: first.nextCursor as string }))
      .rejects.toMatchObject({ code: 'stale_snapshot' })
    expect(h.findMany).toHaveBeenCalledTimes(1)
  })

  test('keeps high-cardinality pages bounded and completes without offset shifts', async () => {
    const firstPage = Array.from({ length: 101 }, (_, index) => row(`unit-${index}`, `key-${String(index).padStart(3, '0')}`))
    h.findMany.mockResolvedValueOnce(firstPage)
    h.count.mockResolvedValueOnce(101)
    const first = await listWorkspaceCodeUnits(ctx, { projectId: 'project-1', limit: 100 })
    expect(first.units).toHaveLength(100)
    expect(first.hasMore).toBe(true)
    expect(h.findMany.mock.calls[0][0].take).toBe(101)

    const anchor = firstPage[99]
    h.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: anchor.id, stableKey: anchor.stableKey, updatedAt: anchor.updatedAt })
    h.count.mockResolvedValueOnce(101)
    h.findMany.mockResolvedValueOnce([firstPage[100]])
    const last = await listWorkspaceCodeUnits(ctx, { projectId: 'project-1', limit: 100, cursor: first.nextCursor as string })
    expect(last.units.map((unit) => unit.id)).toEqual(['unit-100'])
    expect(last.hasMore).toBe(false)
    expect(last.nextCursor).toBeNull()
  })

  test('rejects a cursor reused with different filters and keeps legacy offsets separate', async () => {
    h.findMany.mockResolvedValueOnce([row('unit-a', 'a'), row('unit-b', 'b')])
    h.count.mockResolvedValueOnce(2)
    const first = await listWorkspaceCodeUnits(ctx, { projectId: 'project-1', search: 'Main', limit: 1 })
    await expect(listWorkspaceCodeUnits(ctx, { projectId: 'project-1', search: 'Other', limit: 1, cursor: first.nextCursor as string }))
      .rejects.toMatchObject({ code: 'stale_snapshot' })
    await expect(listWorkspaceCodeUnits(ctx, { projectId: 'project-1', limit: 1, offset: 2, cursor: first.nextCursor as string }))
      .rejects.toMatchObject({ code: 'invalid_input' })
  })

  test('requires restart when a stable cursor expires', async () => {
    h.findMany.mockResolvedValueOnce([row('unit-a', 'a'), row('unit-b', 'b')])
    h.count.mockResolvedValueOnce(2)
    const first = await listWorkspaceCodeUnits(ctx, { projectId: 'project-1', limit: 1 })
    const cursor = JSON.parse(Buffer.from(first.nextCursor as string, 'base64url').toString('utf8')) as Record<string, unknown>
    cursor.expiresAt = Date.now() - 1
    const expired = Buffer.from(JSON.stringify(cursor)).toString('base64url')
    await expect(listWorkspaceCodeUnits(ctx, { projectId: 'project-1', limit: 1, cursor: expired }))
      .rejects.toMatchObject({ code: 'stale_snapshot' })
  })
})

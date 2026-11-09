/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHmac } from 'node:crypto'

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
import { listWorkspaceCodeRelationships, listWorkspaceCodeUnits } from './workspaceCodeTools'
import type { McpContext } from './tools'

const ctx: McpContext = { token: {
  tokenId: 'token-1', userId: 'owner', tokenPrefix: 'rdmn_mcp_aaaaaaaa', name: 'agent', scopes: ['recon:read'],
} }
const cursorSigningKey = 'test-code-unit-cursor-key'
const row = (id: string, stableKey: string, updatedAt = new Date('2026-11-09T10:00:00.000Z')) => ({
  id, stableKey, type: 'code_unit', label: stableKey, source: 'provider-a', taskId: 'task-1', artifactId: 'artifact-1',
  updatedAt, attributes: { name: stableKey }, artifact: { relativePath: 'sample.bin', originalName: 'sample.bin', sha256: 'a'.repeat(64) },
})
const relationshipUnit = {
  id: 'unit-a', stableKey: 'function:a', type: 'code_unit', source: 'provider-a', taskId: 'task-1', artifactId: 'artifact-1',
  artifact: { sha256: 'a'.repeat(64) },
}
const relationship = (id: string, stableKey: string, updatedAt = new Date('2026-11-09T10:00:00.000Z')) => ({
  id, stableKey, type: 'calls', label: stableKey, fromKey: 'function:a', toKey: stableKey,
  attributes: { fromCodeUnitKey: 'function:a', toCodeUnitKey: stableKey },
  createdAt: new Date('2026-11-09T09:00:00.000Z'), updatedAt,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('INTERNAL_API_KEY', cursorSigningKey)
  __resetRateLimiter()
  h.selection.mockResolvedValue({ activeImportIds: new Set(['import-1']), artifactWhere: { projectId: 'project-1', importId: 'import-1' } })
  h.findMany.mockResolvedValue([])
  h.count.mockResolvedValue(0)
  h.findFirst.mockResolvedValue(null)
})

afterEach(() => vi.unstubAllEnvs())

function signCursorPayload(cursor: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  const signature = createHmac('sha256', cursorSigningKey).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

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

  test('continues code-unit pages during key rotation and signs the next cursor with the active key', async () => {
    h.findMany.mockResolvedValueOnce([row('unit-a', 'a'), row('unit-b', 'b')])
    h.count.mockResolvedValueOnce(3)
    const first = await listWorkspaceCodeUnits(ctx, { projectId: 'project-1', limit: 1 })

    vi.stubEnv('INTERNAL_API_KEY', 'rotated-code-unit-cursor-key')
    vi.stubEnv('WORKSPACE_CURSOR_PREVIOUS_KEYS', cursorSigningKey)
    h.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'unit-a', stableKey: 'a', updatedAt: row('unit-a', 'a').updatedAt })
    h.count.mockResolvedValueOnce(3)
    h.findMany.mockResolvedValueOnce([row('unit-b', 'b'), row('unit-c', 'c')])
    const second = await listWorkspaceCodeUnits(ctx, { projectId: 'project-1', limit: 1, cursor: first.nextCursor as string })

    const [payload, signature] = (second.nextCursor as string).split('.')
    expect(signature).toBe(createHmac('sha256', 'rotated-code-unit-cursor-key').update(payload).digest('base64url'))
    expect(second.units.map((unit) => unit.id)).toEqual(['unit-b'])
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
    const [payload] = (first.nextCursor as string).split('.')
    const cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    cursor.expiresAt = Date.now() - 1
    const expired = signCursorPayload(cursor)
    await expect(listWorkspaceCodeUnits(ctx, { projectId: 'project-1', limit: 1, cursor: expired }))
      .rejects.toMatchObject({ code: 'stale_snapshot' })
  })

  test('rejects a modified cursor payload before querying rows', async () => {
    h.findMany.mockResolvedValueOnce([row('unit-a', 'a'), row('unit-b', 'b')])
    h.count.mockResolvedValueOnce(2)
    const first = await listWorkspaceCodeUnits(ctx, { projectId: 'project-1', limit: 1 })
    const [payload, signature] = (first.nextCursor as string).split('.')
    const cursor = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    cursor.lastId = 'unit-b'
    const modifiedPayload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
    await expect(listWorkspaceCodeUnits(ctx, { projectId: 'project-1', limit: 1, cursor: `${modifiedPayload}.${signature}` }))
      .rejects.toMatchObject({ code: 'stale_snapshot' })
    expect(h.findMany).toHaveBeenCalledTimes(1)
  })

  test('does not issue stable cursors when the signing key is unconfigured', async () => {
    vi.stubEnv('INTERNAL_API_KEY', 'changeme')
    h.findMany.mockResolvedValueOnce([row('unit-a', 'a'), row('unit-b', 'b')])
    h.count.mockResolvedValueOnce(2)
    await expect(listWorkspaceCodeUnits(ctx, { projectId: 'project-1', limit: 1 }))
      .rejects.toMatchObject({ code: 'cursor_unavailable' })
  })
})

describe('workspace code-relationship keyset paging', () => {
  const args = { projectId: 'project-1', codeUnitId: 'unit-a', relationshipKind: 'calls' as const, direction: 'incoming' as const, limit: 1 }

  test('continues relationship pages with a prior key and reissues with the active key', async () => {
    h.findFirst.mockResolvedValueOnce(relationshipUnit)
    h.findMany.mockResolvedValueOnce([relationship('edge-a', 'a'), relationship('edge-b', 'b')]).mockResolvedValueOnce([])
    h.count.mockResolvedValueOnce(3)
    const first = await listWorkspaceCodeRelationships(ctx, args)

    vi.stubEnv('INTERNAL_API_KEY', 'rotated-relationship-cursor-key')
    vi.stubEnv('WORKSPACE_CURSOR_PREVIOUS_KEYS', cursorSigningKey)
    h.findFirst.mockResolvedValueOnce(relationshipUnit).mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'edge-a', stableKey: 'a', updatedAt: relationship('edge-a', 'a').updatedAt,
    })
    h.findMany.mockResolvedValueOnce([relationship('edge-b', 'b'), relationship('edge-c', 'c')]).mockResolvedValueOnce([])
    h.count.mockResolvedValueOnce(3).mockResolvedValueOnce(3)
    const second = await listWorkspaceCodeRelationships(ctx, { ...args, cursor: first.nextCursor as string })

    const [payload, signature] = (second.nextCursor as string).split('.')
    expect(signature).toBe(createHmac('sha256', 'rotated-relationship-cursor-key').update(payload).digest('base64url'))
    expect(second.relationships.map((item) => item.stableKey)).toEqual(['b'])
  })

  test('returns a unit-, filter-, import-, and snapshot-bound signed cursor', async () => {
    const timestamp = new Date('2026-11-09T10:00:00.000Z')
    h.findFirst.mockResolvedValueOnce(relationshipUnit)
    h.findMany.mockResolvedValueOnce([relationship('edge-a', 'a'), relationship('edge-b', 'b')]).mockResolvedValueOnce([])
    h.count.mockResolvedValueOnce(2)
    const first = await listWorkspaceCodeRelationships(ctx, args)
    expect(first).toMatchObject({ relationships: [{ stableKey: 'a' }], total: 2, hasMore: true, offset: null })
    expect(first.nextCursor).toEqual(expect.any(String))
    expect(h.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        projectId: 'project-1', taskId: 'task-1', artifactId: 'artifact-1', source: 'provider-a',
        createdAt: { lt: new Date(first.snapshotAt as string) }, updatedAt: { lt: new Date(first.snapshotAt as string) },
        isPending: false,
      },
      orderBy: [{ stableKey: 'asc' }, { id: 'asc' }], take: 2,
    })
    expect(h.findMany.mock.calls[0][0]).not.toHaveProperty('skip')

    h.findFirst.mockResolvedValueOnce(relationshipUnit).mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'edge-a', stableKey: 'a', updatedAt: timestamp,
    })
    h.findMany.mockResolvedValueOnce([relationship('edge-b', 'b')]).mockResolvedValueOnce([])
    h.count.mockResolvedValueOnce(2)
    const second = await listWorkspaceCodeRelationships(ctx, { ...args, cursor: first.nextCursor as string })
    expect(second).toMatchObject({ relationships: [{ stableKey: 'b' }], total: 2, hasMore: false, nextCursor: null })
    expect(h.findMany.mock.calls[2][0]).toMatchObject({
      where: { AND: [{ OR: [
        { stableKey: { gt: 'a' } },
        { stableKey: 'a', id: { gt: 'edge-a' } },
      ] }] },
    })
  })

  test('keeps relationship pages bounded across the 100-row boundary', async () => {
    const all = Array.from({ length: 101 }, (_, index) => relationship(
      `edge-${index}`, `key-${String(index).padStart(3, '0')}`,
    ))
    h.findFirst.mockResolvedValueOnce(relationshipUnit)
    h.findMany.mockResolvedValueOnce(all).mockResolvedValueOnce([])
    h.count.mockResolvedValueOnce(101)
    const first = await listWorkspaceCodeRelationships(ctx, { ...args, limit: 100 })
    expect(first.relationships).toHaveLength(100)
    expect(first).toMatchObject({ total: 101, hasMore: true })
    expect(h.findMany.mock.calls[0][0].take).toBe(101)

    const anchor = all[99]
    h.findFirst.mockResolvedValueOnce(relationshipUnit).mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: anchor.id, stableKey: anchor.stableKey, updatedAt: anchor.updatedAt,
    })
    h.findMany.mockResolvedValueOnce([all[100]]).mockResolvedValueOnce([])
    h.count.mockResolvedValueOnce(101)
    const last = await listWorkspaceCodeRelationships(ctx, { ...args, limit: 100, cursor: first.nextCursor as string })
    expect(last.relationships.map((item) => item.stableKey)).toEqual(['key-100'])
    expect(last.hasMore).toBe(false)
    expect(last.nextCursor).toBeNull()
  })

  test('rejects altered or differently scoped relationship cursors before reading a page', async () => {
    h.findFirst.mockResolvedValue(relationshipUnit)
    h.findFirst.mockResolvedValueOnce(relationshipUnit)
    h.findMany.mockResolvedValueOnce([relationship('edge-a', 'a'), relationship('edge-b', 'b')]).mockResolvedValueOnce([])
    h.count.mockResolvedValueOnce(2)
    const first = await listWorkspaceCodeRelationships(ctx, args)
    const cursor = first.nextCursor as string
    const [payload, signature] = cursor.split('.')
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    decoded.lastId = 'edge-b'
    const altered = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`
    await expect(listWorkspaceCodeRelationships(ctx, { ...args, cursor: altered })).rejects.toMatchObject({ code: 'stale_snapshot' })
    await expect(listWorkspaceCodeRelationships(ctx, { ...args, direction: 'outgoing', cursor })).rejects.toMatchObject({ code: 'stale_snapshot' })
    expect(h.findMany).toHaveBeenCalledTimes(2)
  })

  test('rejects stale relationship snapshots and refuses cursors without a signing key', async () => {
    h.findFirst.mockResolvedValueOnce(relationshipUnit)
    h.findMany.mockResolvedValueOnce([relationship('edge-a', 'a'), relationship('edge-b', 'b')]).mockResolvedValueOnce([])
    h.count.mockResolvedValueOnce(2)
    const first = await listWorkspaceCodeRelationships(ctx, args)
    h.findFirst.mockResolvedValueOnce(relationshipUnit).mockResolvedValueOnce({ id: 'edge-new' })
    await expect(listWorkspaceCodeRelationships(ctx, { ...args, cursor: first.nextCursor as string }))
      .rejects.toMatchObject({ code: 'stale_snapshot' })

    vi.stubEnv('INTERNAL_API_KEY', 'changeme')
    h.findFirst.mockResolvedValueOnce(relationshipUnit)
    h.findMany.mockResolvedValueOnce([relationship('edge-a', 'a'), relationship('edge-b', 'b')]).mockResolvedValueOnce([])
    h.count.mockResolvedValueOnce(2)
    await expect(listWorkspaceCodeRelationships(ctx, args)).rejects.toMatchObject({ code: 'cursor_unavailable' })
  })

  test('preserves explicit offset mode without snapshot guarantees', async () => {
    h.findFirst.mockResolvedValueOnce(relationshipUnit)
    h.findMany.mockResolvedValueOnce([relationship('edge-a', 'a'), relationship('edge-b', 'b')]).mockResolvedValueOnce([])
    const result = await listWorkspaceCodeRelationships(ctx, { ...args, offset: 5 })
    expect(result).toMatchObject({ relationships: [{ stableKey: 'a' }], offset: 5, hasMore: true, nextOffset: 6, nextCursor: null })
    expect(result).not.toHaveProperty('total')
    expect(h.findMany.mock.calls[0][0]).toHaveProperty('skip', 5)
    expect(h.count).not.toHaveBeenCalled()
  })
})

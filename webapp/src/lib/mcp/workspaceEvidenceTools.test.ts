/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({
  assertProject: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  findFirst: vi.fn(),
}))

vi.mock('@/lib/mcpAuth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mcpAuth')>('@/lib/mcpAuth')
  return { ...actual, assertMcpProjectAccess: (...args: unknown[]) => h.assertProject(...args) }
})
vi.mock('@/lib/prisma', () => ({
  default: { evidence: { findMany: (...args: unknown[]) => h.findMany(...args), count: (...args: unknown[]) => h.count(...args), findFirst: (...args: unknown[]) => h.findFirst(...args) } },
}))

import { McpScopeError, __resetRateLimiter } from '@/lib/mcpAuth'
import { getWorkspaceEvidence, listWorkspaceEvidence } from './workspaceEvidenceTools'
import type { McpContext } from './tools'

const ctx = (scopes: string[] = ['recon:read']): McpContext => ({
  token: {
    tokenId: 'token-1', userId: 'owner', tokenPrefix: 'rdmn_mcp_aaaaaaaa',
    name: 'agent', scopes: scopes as never,
  },
})

const evidenceRow = (id: string, createdAt = new Date('2026-11-09T10:00:00.000Z')) => ({
  id,
  targetId: 'target-1',
  artifactId: 'artifact-1',
  kind: 'provider_observation',
  summary: `Summary for ${id}`,
  source: 'ghidra',
  sourceReference: `run-${id}`,
  data: { finding: id } as Record<string, unknown>,
  createdAt,
})

beforeEach(() => {
  vi.clearAllMocks()
  __resetRateLimiter()
  h.findMany.mockResolvedValue([])
  h.count.mockResolvedValue(0)
  h.findFirst.mockResolvedValue(evidenceRow('evidence-1'))
})

describe('persisted workspace evidence MCP tools', () => {
  test('pages records with a project and filter-bound keyset cursor', async () => {
    const timestamp = new Date('2026-11-09T10:00:00.000Z')
    h.findMany.mockResolvedValueOnce([evidenceRow('evidence-c', timestamp), evidenceRow('evidence-b', timestamp), evidenceRow('evidence-a', timestamp)])
    h.count.mockResolvedValue(3)

    const first = await listWorkspaceEvidence(ctx(), { projectId: 'project-1', artifactId: 'artifact-1', limit: 2 })
    expect(first).toMatchObject({ total: 3, hasMore: true, evidence: [{ id: 'evidence-c' }, { id: 'evidence-b' }] })
    expect(first.nextCursor).toEqual(expect.any(String))
    expect(h.findMany.mock.calls[0][0]).toMatchObject({
      where: { projectId: 'project-1', artifactId: 'artifact-1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
    })

    h.findMany.mockResolvedValueOnce([evidenceRow('evidence-a', timestamp)])
    const second = await listWorkspaceEvidence(ctx(), {
      projectId: 'project-1', artifactId: 'artifact-1', limit: 2, cursor: first.nextCursor || undefined,
    })
    expect(second).toMatchObject({ total: 3, hasMore: false, nextCursor: null, evidence: [{ id: 'evidence-a' }] })
    expect(h.findMany.mock.calls[1][0].where).toMatchObject({
      projectId: 'project-1', artifactId: 'artifact-1',
      OR: [
        { createdAt: { lt: timestamp } },
        { createdAt: timestamp, id: { lt: 'evidence-b' } },
      ],
    })
  })

  test('refuses a cursor from another project or filter before querying evidence', async () => {
    h.findMany.mockResolvedValueOnce(Array.from({ length: 26 }, (_, index) => evidenceRow(`evidence-${index}`)))
    const first = await listWorkspaceEvidence(ctx(), { projectId: 'project-1', artifactId: 'artifact-1' })
    await expect(listWorkspaceEvidence(ctx(), {
      projectId: 'project-1', artifactId: 'artifact-2', cursor: first.nextCursor || undefined,
    })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(h.findMany).toHaveBeenCalledTimes(1)
  })

  test('enforces read scope and project authorization before reading records', async () => {
    await expect(listWorkspaceEvidence(ctx([]), { projectId: 'project-1' })).rejects.toBeInstanceOf(McpScopeError)
    expect(h.assertProject).not.toHaveBeenCalled()
    expect(h.findMany).not.toHaveBeenCalled()

    await getWorkspaceEvidence(ctx(), { projectId: 'project-1', evidenceId: 'evidence-1' })
    expect(h.assertProject).toHaveBeenCalledWith('owner', 'project-1')
    expect(h.findFirst.mock.calls[0][0].where).toEqual({ id: 'evidence-1', projectId: 'project-1' })
  })

  test('returns exact UTF-8 JSON in bounded hash-checked pages', async () => {
    const row = evidenceRow('evidence-large')
    row.summary = `${'a'.repeat(131_060)}🙂${'b'.repeat(2000)}`
    row.data = { note: 'evidence stays in storage', nested: { answer: 42 } }
    h.findFirst.mockResolvedValue(row)

    const pages: string[] = []
    let offsetBytes = 0
    let evidenceHash: string | undefined
    let response: Awaited<ReturnType<typeof getWorkspaceEvidence>>
    do {
      response = await getWorkspaceEvidence(ctx(), { projectId: 'project-1', evidenceId: row.id, offsetBytes, evidenceHash })
      pages.push(response.detailsJson)
      evidenceHash = response.evidenceHash
      offsetBytes = response.nextOffsetBytes
      expect(Buffer.byteLength(response.detailsJson, 'utf8')).toBeLessThanOrEqual(128 * 1024)
    } while (response.hasMore)

    expect(pages.length).toBeGreaterThan(1)
    expect(JSON.parse(pages.join(''))).toEqual({ summary: row.summary, data: row.data })
    expect(response).toMatchObject({ hasMore: false, totalBytes: offsetBytes })
  })

  test('requires the returned hash for continuation and rejects stale evidence', async () => {
    const first = await getWorkspaceEvidence(ctx(), { projectId: 'project-1', evidenceId: 'evidence-1', offsetBytes: 1 })
      .catch((error: unknown) => error)
    expect(first).toMatchObject({ code: 'invalid_input' })

    await expect(getWorkspaceEvidence(ctx(), {
      projectId: 'project-1', evidenceId: 'evidence-1', offsetBytes: 1, evidenceHash: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'stale_evidence' })
  })

  test('does not disclose a missing evidence id from another project', async () => {
    h.findFirst.mockResolvedValue(null)
    await expect(getWorkspaceEvidence(ctx(), { projectId: 'project-1', evidenceId: 'foreign' }))
      .rejects.toMatchObject({ code: 'not_found' })
    expect(h.findFirst.mock.calls[0][0].where).toEqual({ id: 'foreign', projectId: 'project-1' })
  })
})

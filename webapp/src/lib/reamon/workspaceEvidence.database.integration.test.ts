/** @vitest-environment node */
/**
 * PostgreSQL acceptance for signed evidence paging. Auto-skips without a
 * database URL and removes its synthetic project and evidence afterward.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'

import { __resetRateLimiter } from '@/lib/mcpAuth'
import { listPersistedWorkspaceEvidence } from './workspace-evidence'
import { listWorkspaceEvidence } from '@/lib/mcp/workspaceEvidenceTools'
import type { McpContext } from '@/lib/mcp/tools'

const HAS_DB = process.env.DATABASE_URL !== undefined
const SUFFIX = `workspace-evidence-cursor-${Date.now()}`

let prisma: PrismaClient
let userId = ''
let projectId = ''
let artifactId = ''
const originalSigningKey = process.env.INTERNAL_API_KEY
const stableCreatedAt = new Date('2025-01-01T00:00:00.000Z')

const ctx = (): McpContext => ({
  token: {
    tokenId: 'workspace-evidence-integration',
    userId,
    tokenPrefix: 'rdmn_mcp_aaaaaaaa',
    name: 'evidence integration',
    scopes: ['recon:read'] as never,
  },
})

beforeAll(async () => {
  if (!HAS_DB) return
  process.env.INTERNAL_API_KEY = 'integration-workspace-evidence-cursor-key'
  prisma = new PrismaClient()
  const user = await prisma.user.create({
    data: { email: `${SUFFIX}@example.invalid`, name: 'workspace evidence cursor integration' },
  })
  userId = user.id
  const project = await prisma.project.create({
    data: { name: 'workspace evidence cursor integration', userId, targetDomain: 'example.invalid' },
  })
  projectId = project.id
  const artifact = await prisma.artifact.create({
    data: {
      projectId,
      name: 'synthetic-evidence.bin',
      originalName: 'synthetic-evidence.bin',
      storagePath: `integration/${SUFFIX}.bin`,
      sha256: 'b'.repeat(64),
      sizeBytes: 1,
    },
  })
  artifactId = artifact.id
  await prisma.evidence.createMany({
    data: Array.from({ length: 51 }, (_, index) => ({
      projectId,
      kind: 'integration',
      summary: `synthetic evidence ${index}`,
      source: SUFFIX,
      sourceReference: `record-${index}`,
      data: { index },
      createdAt: stableCreatedAt,
    })),
  })
}, 60_000)

afterAll(async () => {
  if (!HAS_DB || !prisma) return
  try { await prisma.project.delete({ where: { id: projectId } }) } catch { /* cascade */ }
  try { await prisma.user.delete({ where: { id: userId } }) } catch { /* cleanup after cascade */ }
  expect(await prisma.project.count({ where: { id: projectId } })).toBe(0)
  expect(await prisma.user.count({ where: { id: userId } })).toBe(0)
  expect(await prisma.evidence.count({ where: { projectId } })).toBe(0)
  await prisma.$disconnect()
  if (originalSigningKey === undefined) delete process.env.INTERNAL_API_KEY
  else process.env.INTERNAL_API_KEY = originalSigningKey
})

beforeEach(() => __resetRateLimiter())

describe.skipIf(!HAS_DB)('workspace evidence pagination against PostgreSQL', () => {
  test('keeps a signed 51-row snapshot stable when later evidence is added', async () => {
    const first = await listWorkspaceEvidence(ctx(), { projectId, limit: 50 })
    expect(first.evidence).toHaveLength(50)
    expect(first.total).toBe(51)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toEqual(expect.any(String))

    await prisma.evidence.create({
      data: {
        projectId,
        kind: 'integration',
        summary: 'created after the first-page snapshot',
        source: SUFFIX,
        sourceReference: 'later-record',
        data: { later: true },
        createdAt: new Date(Date.now() + 60_000),
      },
    })
    const last = await listWorkspaceEvidence(ctx(), { projectId, limit: 50, cursor: first.nextCursor as string })
    expect(last.evidence).toHaveLength(1)
    expect(last.total).toBe(51)
    expect(last.hasMore).toBe(false)
  })

  test('rejects a continuation after a row from its snapshot is deleted', async () => {
    const first = await listPersistedWorkspaceEvidence({ projectId, limit: 1 })
    const anchorId = first.evidence[0].id
    await prisma.evidence.delete({ where: { id: anchorId } })
    await expect(listPersistedWorkspaceEvidence({
      projectId,
      limit: 1,
      cursor: first.nextCursor as string,
    })).rejects.toMatchObject({ code: 'stale_snapshot' })
  })

  test('uses project and artifact keyset indexes for a 100,000-row evidence set', async () => {
    await prisma.$executeRaw`
      INSERT INTO reamon_evidence (id, project_id, artifact_id, kind, summary, source, source_reference, data, created_at)
      SELECT 'bench-' || ${SUFFIX} || '-' || lpad(n::text, 6, '0'), ${projectId},
        CASE WHEN n % 10 = 0 THEN ${artifactId} ELSE NULL END,
        'integration', 'synthetic high-cardinality row', ${SUFFIX},
        'benchmark-' || n::text, '{}'::jsonb,
        ${stableCreatedAt}::timestamptz + n * interval '1 millisecond'
      FROM generate_series(1, 100000) AS n
    `
    await prisma.$executeRaw`ANALYZE reamon_evidence`

    const first = await listWorkspaceEvidence(ctx(), { projectId, artifactId, limit: 50 })
    expect(first.evidence).toHaveLength(50)
    expect(first.total).toBe(10000)
    expect(first.hasMore).toBe(true)
    const cursorPayload = JSON.parse(Buffer.from((first.nextCursor as string).split('.')[0], 'base64url').toString('utf8')) as Record<string, unknown>
    expect(cursorPayload.id).toContain(SUFFIX)
    const second = await listWorkspaceEvidence(ctx(), {
      projectId, artifactId, limit: 50, cursor: first.nextCursor as string,
    })
    expect(second.evidence).toHaveLength(50)
    expect(second.total).toBe(10000)

    const noArtifactPlan = await prisma.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: { Plans?: unknown[]; [key: string]: unknown } }> }>>`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM reamon_evidence
      WHERE project_id = ${projectId} AND created_at <= now()
      ORDER BY created_at DESC, id DESC LIMIT 26
    `
    const artifactPlan = await prisma.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: { Plans?: unknown[]; [key: string]: unknown } }> }>>`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM reamon_evidence
      WHERE project_id = ${projectId} AND artifact_id = ${artifactId} AND created_at <= now()
      ORDER BY created_at DESC, id DESC LIMIT 26
    `
    const indexNames = (root: Record<string, unknown>): string[] => [
      ...(typeof root['Index Name'] === 'string' ? [root['Index Name']] : []),
      ...((root.Plans as Array<Record<string, unknown>> | undefined) ?? []).flatMap(indexNames),
    ]
    expect(indexNames(noArtifactPlan[0]['QUERY PLAN'][0].Plan as Record<string, unknown>))
      .toContain('reamon_evidence_project_id_created_at_id_idx')
    expect(indexNames(artifactPlan[0]['QUERY PLAN'][0].Plan as Record<string, unknown>))
      .toContain('reamon_evidence_project_id_artifact_id_created_at_id_idx')
  }, 60_000)
})

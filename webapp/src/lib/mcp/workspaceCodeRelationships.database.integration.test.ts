/** @vitest-environment node */
/**
 * PostgreSQL acceptance for signed relationship paging. Auto-skips unless
 * DATABASE_URL is set; fixtures use synthetic rows and are removed afterward.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'

import { __resetRateLimiter } from '@/lib/mcpAuth'
import { listWorkspaceCodeRelationships } from './workspaceCodeTools'
import type { McpContext } from './tools'

const HAS_DB = process.env.DATABASE_URL !== undefined
const SUFFIX = `workspace-relationship-cursor-${Date.now()}`

let prisma: PrismaClient
let userId = ''
let projectId = ''
let taskId = ''
let artifactId = ''
let codeUnitId = ''
const originalSigningKey = process.env.INTERNAL_API_KEY

const ctx = (): McpContext => ({
  token: {
    tokenId: 'workspace-relationship-integration',
    userId,
    tokenPrefix: 'rdmn_mcp_aaaaaaaa',
    name: 'relationship integration',
    scopes: ['recon:read'] as never,
  },
})

beforeAll(async () => {
  if (!HAS_DB) return
  process.env.INTERNAL_API_KEY = 'integration-workspace-cursor-key'
  prisma = new PrismaClient()
  const user = await prisma.user.create({
    data: { email: `${SUFFIX}@example.invalid`, name: 'workspace cursor integration' },
  })
  userId = user.id
  const project = await prisma.project.create({
    data: { name: 'workspace relationship cursor integration', userId, targetDomain: 'example.invalid' },
  })
  projectId = project.id
  const artifact = await prisma.artifact.create({
    data: {
      projectId,
      name: 'synthetic.bin',
      originalName: 'synthetic.bin',
      storagePath: `integration/${SUFFIX}.bin`,
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
    },
  })
  artifactId = artifact.id
  const task = await prisma.task.create({
    data: { projectId, title: 'synthetic relationship analysis', category: 'analysis', status: 'COMPLETED' },
  })
  taskId = task.id
  const unit = await prisma.reamonObservation.create({
    data: {
      projectId, taskId, artifactId, kind: 'code_unit', type: 'code_unit',
      stableKey: 'integration-root-function', canonicalKey: 'integration-root-function', source: SUFFIX,
      label: 'rootFunction', attributes: { name: 'rootFunction' },
    },
  })
  codeUnitId = unit.id
  await prisma.reamonObservation.createMany({
    data: Array.from({ length: 101 }, (_, index) => ({
      projectId,
      taskId,
      artifactId,
      kind: 'relationship',
      type: 'calls',
      stableKey: `integration-edge-${String(index).padStart(3, '0')}`,
      canonicalKey: `integration-edge-${String(index).padStart(3, '0')}`,
      source: SUFFIX,
      fromKey: 'integration-root-function',
      toKey: `integration-callee-${index}`,
      attributes: { fromCodeUnitKey: 'integration-root-function', toCodeUnitKey: `integration-callee-${index}` },
    })),
  })
}, 60_000)

afterAll(async () => {
  if (!HAS_DB || !prisma) return
  try { await prisma.project.delete({ where: { id: projectId } }) } catch { /* cascade */ }
  try { await prisma.user.delete({ where: { id: userId } }) } catch { /* cleanup after cascade */ }
  expect(await prisma.project.count({ where: { id: projectId } })).toBe(0)
  expect(await prisma.user.count({ where: { id: userId } })).toBe(0)
  expect(await prisma.reamonObservation.count({ where: { projectId, source: SUFFIX } })).toBe(0)
  await prisma.$disconnect()
  if (originalSigningKey === undefined) delete process.env.INTERNAL_API_KEY
  else process.env.INTERNAL_API_KEY = originalSigningKey
})

beforeEach(() => __resetRateLimiter())

describe.skipIf(!HAS_DB)('workspace relationship pagination against PostgreSQL', () => {
  test('continues a stable 101-row snapshot without offset drift', async () => {
    const first = await listWorkspaceCodeRelationships(ctx(), {
      projectId, codeUnitId, relationshipKind: 'calls', direction: 'outgoing', limit: 100,
    })
    expect(first.relationships).toHaveLength(100)
    expect(first.total).toBe(101)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toEqual(expect.any(String))

    const last = await listWorkspaceCodeRelationships(ctx(), {
      projectId, codeUnitId, relationshipKind: 'calls', direction: 'outgoing', limit: 100,
      cursor: first.nextCursor as string,
    })
    expect(last.relationships.map((item) => item.stableKey)).toEqual(['integration-edge-100'])
    expect(last.hasMore).toBe(false)
    expect(last.nextCursor).toBeNull()
  })

  test('rejects a snapshot after a relationship row is updated', async () => {
    const first = await listWorkspaceCodeRelationships(ctx(), {
      projectId, codeUnitId, relationshipKind: 'calls', direction: 'outgoing', limit: 1,
    })
    const row = await prisma.reamonObservation.findFirstOrThrow({
      where: { projectId, taskId, artifactId, source: SUFFIX, stableKey: 'integration-edge-050' },
      select: { id: true },
    })
    await prisma.reamonObservation.update({ where: { id: row.id }, data: { label: 'updated after snapshot' } })
    await expect(listWorkspaceCodeRelationships(ctx(), {
      projectId, codeUnitId, relationshipKind: 'calls', direction: 'outgoing', limit: 1,
      cursor: first.nextCursor as string,
    })).rejects.toMatchObject({ code: 'stale_snapshot' })
  })
})

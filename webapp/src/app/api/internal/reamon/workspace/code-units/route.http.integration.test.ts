/** @vitest-environment node */
/**
 * PostgreSQL-backed acceptance for agent code-unit and relationship paging
 * across a Next.js restart. It is opt-in without DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { createHmac } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'

import { signTag } from '@/lib/redamonCtx'
import { AUTH_COOKIE_NAME, createToken } from '@/lib/auth'

const HAS_DB = process.env.DATABASE_URL !== undefined
const SUFFIX = `workspace-code-http-${Date.now()}`
const INITIAL_KEY = 'integration-code-http-old-cursor-key'
const ROTATED_KEY = 'integration-code-http-rotated-cursor-key'

let prisma: PrismaClient
let userId = ''
let foreignUserId = ''
let projectId = ''
let taskId = ''
let artifactId = ''
let codeUnitId = ''
let ownerSession = ''
let foreignSession = ''

beforeAll(async () => {
  if (!HAS_DB) return
  process.env.AUTH_SECRET = 'integration-http-auth-secret'
  prisma = new PrismaClient()
  const user = await prisma.user.create({
    data: { email: `${SUFFIX}@example.invalid`, name: 'workspace code HTTP integration' },
  })
  userId = user.id
  const foreignUser = await prisma.user.create({
    data: { email: `${SUFFIX}-foreign@example.invalid`, name: 'foreign workspace code HTTP integration' },
  })
  foreignUserId = foreignUser.id
  ownerSession = await createToken(userId, 'standard')
  foreignSession = await createToken(foreignUserId, 'standard')
  const project = await prisma.project.create({
    data: { name: 'workspace code HTTP integration', userId, targetDomain: 'code-http.example.invalid' },
  })
  projectId = project.id
  const artifact = await prisma.artifact.create({
    data: {
      projectId, name: 'synthetic.bin', originalName: 'synthetic.bin',
      storagePath: `integration/${SUFFIX}.bin`, sha256: 'b'.repeat(64), sizeBytes: 1,
    },
  })
  artifactId = artifact.id
  const task = await prisma.task.create({
    data: { projectId, title: 'synthetic code HTTP analysis', category: 'analysis', status: 'COMPLETED' },
  })
  taskId = task.id
  const unit = await prisma.reamonObservation.create({
    data: {
      projectId, taskId, artifactId, kind: 'code_unit', type: 'code_unit',
      stableKey: 'http-root-function', canonicalKey: 'http-root-function', source: SUFFIX,
      label: 'rootFunction', attributes: { name: 'rootFunction' },
    },
  })
  codeUnitId = unit.id
  await prisma.reamonObservation.createMany({
    data: ['http-callee-a', 'http-callee-b'].map((key) => ({
      projectId, taskId, artifactId, kind: 'code_unit', type: 'code_unit',
      stableKey: key, canonicalKey: key, source: SUFFIX, label: key,
      attributes: { name: key },
    })),
  })
  await prisma.reamonObservation.createMany({
    data: ['http-edge-a', 'http-edge-b', 'http-edge-c'].map((key, index) => ({
      projectId, taskId, artifactId, kind: 'relationship', type: 'calls',
      stableKey: key, canonicalKey: key, source: SUFFIX,
      fromKey: 'http-root-function', toKey: `http-callee-${index}`,
      attributes: { fromCodeUnitKey: 'http-root-function', toCodeUnitKey: `http-callee-${index}` },
    })),
  })
}, 60_000)

afterAll(async () => {
  if (!HAS_DB || !prisma) return
  try { await prisma.project.delete({ where: { id: projectId } }) } catch { /* cascade */ }
  try { await prisma.user.delete({ where: { id: userId } }) } catch { /* cleanup after cascade */ }
  try { await prisma.user.delete({ where: { id: foreignUserId } }) } catch { /* cleanup after cascade */ }
  expect(await prisma.project.count({ where: { id: projectId } })).toBe(0)
  expect(await prisma.user.count({ where: { id: userId } })).toBe(0)
  expect(await prisma.user.count({ where: { id: foreignUserId } })).toBe(0)
  expect(await prisma.artifact.count({ where: { id: artifactId } })).toBe(0)
  expect(await prisma.task.count({ where: { id: taskId } })).toBe(0)
  expect(await prisma.reamonObservation.count({ where: { projectId, source: SUFFIX } })).toBe(0)
  await prisma.$disconnect()
})

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local test port.')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function stopServer(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.killed) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
  if (child.exitCode === null) {
    const killed = once(child, 'exit')
    child.kill('SIGKILL')
    await killed
  }
}

async function startNextServer(activeKey: string, previousKeys = '', databaseUrl = process.env.DATABASE_URL): Promise<{ child: ChildProcess; baseUrl: string }> {
  const port = await availablePort()
  const child = spawn(process.execPath, [
    './node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port),
  ], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: {
      ...process.env,
      INTERNAL_API_KEY: activeKey,
      SCANNER_API_KEY: 'integration-distinct-scanner-key',
      WORKSPACE_CURSOR_PREVIOUS_KEYS: previousKeys,
      INTERNAL_KEY_ALLOWLIST_ENFORCE: 'false',
      ACCESS_ENFORCE: '0',
      AUTH_SECRET: 'integration-http-auth-secret',
      ...(databaseUrl !== undefined ? { DATABASE_URL: databaseUrl } : {}),
    },
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next.js test process exited before readiness (${child.exitCode}).`)
    try {
      const response = await fetch(`${baseUrl}/api/internal/reamon/workspace/code-units`, { method: 'POST', body: '{}' })
      if (response.status === 401) return { child, baseUrl }
    } catch { /* the server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stopServer(child)
  throw new Error('Next.js test process did not become ready within 60 seconds.')
}

function agentHeaders(key: string, tool: 'workspace_list_code_units' | 'workspace_list_code_relationships', contextUserId = userId) {
  const tag = signTag({
    source: 'agent', project_id: projectId, user_id: contextUserId, tool,
    exp: Math.floor(Date.now() / 1000) + 120,
  }, key)
  return { 'x-internal-key': key, 'x-redamon-ctx': tag, 'content-type': 'application/json' }
}

async function requestPage<T>(baseUrl: string, key: string, tool: 'workspace_list_code_units' | 'workspace_list_code_relationships', args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${baseUrl}/api/internal/reamon/workspace/code-units`, {
    method: 'POST', headers: agentHeaders(key, tool), body: JSON.stringify({ tool, ...args }),
  })
  expect(response.status).toBe(200)
  return await response.json() as T
}

function expectActiveKeySignature(cursor: string, key: string) {
  const [payload, signature] = cursor.split('.')
  expect(signature).toBe(createHmac('sha256', key).update(payload).digest('base64url'))
}

describe.skipIf(!HAS_DB)('agent code-unit and relationship HTTP paging across Next.js restart', () => {
  test('continues both persisted cursors after restart and key rotation', async () => {
    let firstServer: ChildProcess | null = null
    let secondServer: ChildProcess | null = null
    try {
      const first = await startNextServer(INITIAL_KEY)
      firstServer = first.child

      const foreignCodeUnitsResponse = await fetch(`${first.baseUrl}/api/internal/reamon/workspace/code-units`, {
        method: 'POST',
        headers: agentHeaders(INITIAL_KEY, 'workspace_list_code_units', foreignUserId),
        body: JSON.stringify({ tool: 'workspace_list_code_units', taskId, limit: 1 }),
      })
      expect(foreignCodeUnitsResponse.status).toBe(404)
      const foreignRelationshipsResponse = await fetch(`${first.baseUrl}/api/internal/reamon/workspace/code-units`, {
        method: 'POST',
        headers: agentHeaders(INITIAL_KEY, 'workspace_list_code_relationships', foreignUserId),
        body: JSON.stringify({
          tool: 'workspace_list_code_relationships', codeUnitId,
          relationshipKind: 'calls', direction: 'outgoing', limit: 1,
        }),
      })
      expect(foreignRelationshipsResponse.status).toBe(404)

      const firstUnits = await requestPage<{
        units: Array<{ stableKey: string }>; total: number; nextCursor: string | null
      }>(first.baseUrl, INITIAL_KEY, 'workspace_list_code_units', { taskId, limit: 1 })
      expect(firstUnits.total).toBe(3)
      expect(firstUnits.units).toHaveLength(1)
      expect(firstUnits.nextCursor).toEqual(expect.any(String))

      const firstRelationships = await requestPage<{
        relationships: Array<{ stableKey: string }>; total: number; nextCursor: string | null
      }>(first.baseUrl, INITIAL_KEY, 'workspace_list_code_relationships', {
        codeUnitId, relationshipKind: 'calls', direction: 'outgoing', limit: 1,
      })
      expect(firstRelationships.total).toBe(3)
      expect(firstRelationships.relationships).toHaveLength(1)
      expect(firstRelationships.nextCursor).toEqual(expect.any(String))

      await stopServer(firstServer)
      firstServer = null

      const second = await startNextServer(ROTATED_KEY, INITIAL_KEY)
      secondServer = second.child

      const nextUnits = await requestPage<{
        units: Array<{ stableKey: string }>; total: number; nextCursor: string | null
      }>(second.baseUrl, ROTATED_KEY, 'workspace_list_code_units', {
        taskId, limit: 1, cursor: firstUnits.nextCursor,
      })
      expect(nextUnits.units).toHaveLength(1)
      expect(nextUnits.total).toBe(3)
      expect(nextUnits.nextCursor).toEqual(expect.any(String))
      expectActiveKeySignature(nextUnits.nextCursor as string, ROTATED_KEY)

      const lastUnits = await requestPage<{
        units: Array<{ stableKey: string }>; total: number; nextCursor: string | null
      }>(second.baseUrl, ROTATED_KEY, 'workspace_list_code_units', {
        taskId, limit: 1, cursor: nextUnits.nextCursor,
      })
      expect(lastUnits.units).toHaveLength(1)
      expect(lastUnits.total).toBe(3)
      expect(lastUnits.nextCursor).toBeNull()

      const nextRelationships = await requestPage<{
        relationships: Array<{ stableKey: string }>; total: number; nextCursor: string | null
      }>(second.baseUrl, ROTATED_KEY, 'workspace_list_code_relationships', {
        codeUnitId, relationshipKind: 'calls', direction: 'outgoing', limit: 1,
        cursor: firstRelationships.nextCursor,
      })
      expect(nextRelationships.relationships).toHaveLength(1)
      expect(nextRelationships.total).toBe(3)
      expect(nextRelationships.nextCursor).toEqual(expect.any(String))
      expectActiveKeySignature(nextRelationships.nextCursor as string, ROTATED_KEY)

      const lastRelationships = await requestPage<{
        relationships: Array<{ stableKey: string }>; total: number; nextCursor: string | null
      }>(second.baseUrl, ROTATED_KEY, 'workspace_list_code_relationships', {
        codeUnitId, relationshipKind: 'calls', direction: 'outgoing', limit: 1,
        cursor: nextRelationships.nextCursor,
      })
      expect(lastRelationships.relationships).toHaveLength(1)
      expect(lastRelationships.total).toBe(3)
      expect(lastRelationships.nextCursor).toBeNull()
    } finally {
      await stopServer(secondServer)
      await stopServer(firstServer)
    }
  }, 180_000)

  test('browser sessions can page owned code units and relationships but cannot read another owner project', async () => {
    let server: ChildProcess | null = null
    try {
      const running = await startNextServer(INITIAL_KEY)
      server = running.child
      const headers = { Cookie: `${AUTH_COOKIE_NAME}=${ownerSession}` }
      const foreignHeaders = { Cookie: `${AUTH_COOKIE_NAME}=${foreignSession}` }

      const anonymousUnits = await fetch(`${running.baseUrl}/api/projects/${projectId}/workspace/code-units?taskId=${taskId}&limit=1`)
      expect(anonymousUnits.status).toBe(401)
      const ownedUnits = await fetch(`${running.baseUrl}/api/projects/${projectId}/workspace/code-units?taskId=${taskId}&limit=1`, { headers })
      expect(ownedUnits.status).toBe(200)
      expect(ownedUnits.headers.get('cache-control')).toBe('private, no-store')
      const unitPage = await ownedUnits.json() as { total: number; units: unknown[]; nextCursor: string | null }
      expect(unitPage.total).toBe(3)
      expect(unitPage.units).toHaveLength(1)
      expect(unitPage.nextCursor).toEqual(expect.any(String))

      const ownedRelationships = await fetch(`${running.baseUrl}/api/projects/${projectId}/workspace/code-relationships?codeUnitId=${codeUnitId}&relationshipKind=calls&direction=outgoing&limit=1`, { headers })
      expect(ownedRelationships.status).toBe(200)
      expect(ownedRelationships.headers.get('cache-control')).toBe('private, no-store')
      const relationshipPage = await ownedRelationships.json() as { total: number; relationships: unknown[]; nextCursor: string | null }
      expect(relationshipPage.total).toBe(3)
      expect(relationshipPage.relationships).toHaveLength(1)
      expect(relationshipPage.nextCursor).toEqual(expect.any(String))

      const foreignUnits = await fetch(`${running.baseUrl}/api/projects/${projectId}/workspace/code-units?taskId=${taskId}&limit=1`, { headers: foreignHeaders })
      expect(foreignUnits.status).toBe(404)
      const foreignRelationships = await fetch(`${running.baseUrl}/api/projects/${projectId}/workspace/code-relationships?codeUnitId=${codeUnitId}&relationshipKind=calls&direction=outgoing&limit=1`, { headers: foreignHeaders })
      expect(foreignRelationships.status).toBe(404)

      const foreignVisualizer = await fetch(`${running.baseUrl}/api/projects/${projectId}/visualizer`, { headers: foreignHeaders })
      expect(foreignVisualizer.status).toBe(404)
      const foreignCallgraph = await fetch(`${running.baseUrl}/api/projects/${projectId}/visualizer/callgraph?taskId=${taskId}&unitId=${codeUnitId}`, { headers: foreignHeaders })
      expect(foreignCallgraph.status).toBe(404)

      const malformedUnitsCursor = await fetch(`${running.baseUrl}/api/projects/${projectId}/workspace/code-units?taskId=${taskId}&limit=1&cursor=not-a-signed-cursor`, { headers })
      expect(malformedUnitsCursor.status).toBe(409)
      expect(await malformedUnitsCursor.json()).toMatchObject({ error: { code: 'stale_snapshot' } })
      const malformedRelationshipsCursor = await fetch(`${running.baseUrl}/api/projects/${projectId}/workspace/code-relationships?codeUnitId=${codeUnitId}&relationshipKind=calls&direction=outgoing&limit=1&cursor=not-a-signed-cursor`, { headers })
      expect(malformedRelationshipsCursor.status).toBe(409)
      expect(await malformedRelationshipsCursor.json()).toMatchObject({ error: { code: 'stale_snapshot' } })
    } finally {
      await stopServer(server)
    }
  }, 180_000)

  test.each([
    ['unsafe default active key', 'changeme', ''],
    ['more than three previous keys', INITIAL_KEY, 'previous-one,previous-two,previous-three,previous-four'],
  ])('fails closed for %s on browser code-unit and relationship paging', async (_caseName, activeKey, previousKeys) => {
    let server: ChildProcess | null = null
    try {
      const running = await startNextServer(activeKey, previousKeys)
      server = running.child
      const headers = { Cookie: `${AUTH_COOKIE_NAME}=${ownerSession}` }
      const units = await fetch(`${running.baseUrl}/api/projects/${projectId}/workspace/code-units?taskId=${taskId}&limit=1`, { headers })
      expect(units.status).toBe(503)
      expect(units.headers.get('cache-control')).toBe('private, no-store')
      expect(await units.json()).toMatchObject({ error: { code: 'cursor_unavailable' } })

      const relationships = await fetch(`${running.baseUrl}/api/projects/${projectId}/workspace/code-relationships?codeUnitId=${codeUnitId}&relationshipKind=calls&direction=outgoing&limit=1`, { headers })
      expect(relationships.status).toBe(503)
      expect(relationships.headers.get('cache-control')).toBe('private, no-store')
      expect(await relationships.json()).toMatchObject({ error: { code: 'cursor_unavailable' } })
    } finally {
      await stopServer(server)
    }
  }, 180_000)

  test('returns server errors without workspace data when the browser paging database is unreachable', async () => {
    let server: ChildProcess | null = null
    try {
      const unreachableDatabase = 'postgresql://unavailable:unavailable@127.0.0.1:1/rea_test?connect_timeout=1'
      const running = await startNextServer(INITIAL_KEY, '', unreachableDatabase)
      server = running.child
      const headers = { Cookie: `${AUTH_COOKIE_NAME}=${ownerSession}` }
      const units = await fetch(`${running.baseUrl}/api/projects/${projectId}/workspace/code-units?taskId=${taskId}&limit=1`, { headers })
      expect(units.status).toBe(500)
      expect(units.headers.get('cache-control')).toBe('private, no-store')
      expect(await units.json()).toEqual({ error: 'Failed to list workspace code units' })

      const relationships = await fetch(`${running.baseUrl}/api/projects/${projectId}/workspace/code-relationships?codeUnitId=${codeUnitId}&relationshipKind=calls&direction=outgoing&limit=1`, { headers })
      expect(relationships.status).toBe(500)
      expect(relationships.headers.get('cache-control')).toBe('private, no-store')
      expect(await relationships.json()).toEqual({ error: 'Failed to list workspace code relationships' })
    } finally {
      await stopServer(server)
    }
  }, 180_000)
})

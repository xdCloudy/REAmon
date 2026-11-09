/** @vitest-environment node */
/**
 * End-to-end acceptance for agent Evidence paging across a Next.js restart.
 * It is opt-in without DATABASE_URL and uses isolated synthetic records.
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
const SUFFIX = `workspace-evidence-http-${Date.now()}`
const INITIAL_KEY = 'integration-http-old-cursor-key'
const ROTATED_KEY = 'integration-http-rotated-cursor-key'

let prisma: PrismaClient
let userId = ''
let foreignUserId = ''
let projectId = ''
let evidenceId = ''
let artifactId = ''
let findingId = ''
let sessionCookie = ''
let foreignSessionCookie = ''
let originalInternalKey: string | undefined
let originalPreviousKeys: string | undefined
let originalAuthSecret: string | undefined

beforeAll(async () => {
  if (!HAS_DB) return
  originalInternalKey = process.env.INTERNAL_API_KEY
  originalPreviousKeys = process.env.WORKSPACE_CURSOR_PREVIOUS_KEYS
  originalAuthSecret = process.env.AUTH_SECRET
  process.env.AUTH_SECRET = 'integration-http-auth-secret'
  prisma = new PrismaClient()
  const user = await prisma.user.create({
    data: { email: `${SUFFIX}@example.invalid`, name: 'workspace evidence HTTP integration' },
  })
  userId = user.id
  const foreignUser = await prisma.user.create({
    data: { email: `${SUFFIX}-foreign@example.invalid`, name: 'foreign workspace evidence HTTP integration' },
  })
  foreignUserId = foreignUser.id
  const project = await prisma.project.create({
    data: { name: 'workspace evidence HTTP integration', userId, targetDomain: 'http.example.invalid' },
  })
  projectId = project.id
  sessionCookie = await createToken(userId, 'standard')
  foreignSessionCookie = await createToken(foreignUserId, 'standard')
  await prisma.evidence.createMany({
    data: Array.from({ length: 4 }, (_, index) => ({
      projectId,
      kind: 'integration',
      summary: `HTTP cursor record ${index + 1}`,
      source: SUFFIX,
      sourceReference: `http-record-${index + 1}`,
      data: { index: index + 1 },
      createdAt: new Date(Date.now() - (index + 1) * 1_000),
    })),
  })
  const evidence = await prisma.evidence.findFirst({
    where: { projectId, source: SUFFIX, summary: 'HTTP cursor record 1' },
    select: { id: true },
  })
  if (!evidence) throw new Error('The synthetic Evidence record was not created.')
  evidenceId = evidence.id
  const artifact = await prisma.artifact.create({
    data: {
      projectId,
      name: 'synthetic.exe',
      originalName: 'synthetic.exe',
      relativePath: 'bin/synthetic.exe',
      storagePath: `integration/${SUFFIX}/synthetic.exe`,
      sha256: 'a'.repeat(64),
      sizeBytes: 17,
      extension: 'exe',
    },
  })
  artifactId = artifact.id
  const finding = await prisma.finding.create({
    data: {
      projectId,
      artifactId,
      title: 'Synthetic workspace review finding',
      description: 'Synthetic fixture for strict workspace ownership acceptance.',
      severity: 'medium',
      source: SUFFIX,
    },
  })
  findingId = finding.id
}, 60_000)

afterAll(async () => {
  if (!HAS_DB || !prisma) return
  try { await prisma.project.delete({ where: { id: projectId } }) } catch { /* cascade */ }
  try { await prisma.user.delete({ where: { id: userId } }) } catch { /* cleanup after cascade */ }
  try { await prisma.user.delete({ where: { id: foreignUserId } }) } catch { /* cleanup after cascade */ }
  expect(await prisma.project.count({ where: { id: projectId } })).toBe(0)
  expect(await prisma.user.count({ where: { id: userId } })).toBe(0)
  expect(await prisma.user.count({ where: { id: foreignUserId } })).toBe(0)
  expect(await prisma.evidence.count({ where: { projectId } })).toBe(0)
  await prisma.$disconnect()
  if (originalInternalKey === undefined) delete process.env.INTERNAL_API_KEY
  else process.env.INTERNAL_API_KEY = originalInternalKey
  if (originalPreviousKeys === undefined) delete process.env.WORKSPACE_CURSOR_PREVIOUS_KEYS
  else process.env.WORKSPACE_CURSOR_PREVIOUS_KEYS = originalPreviousKeys
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = originalAuthSecret
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

async function startNextServer(activeKey: string, previousKeys = ''): Promise<{ child: ChildProcess; baseUrl: string }> {
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
      REAMON_NEXT_TEST_DIST_DIR: `.next-integration-${port}`,
    },
  })
  const baseUrl = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next.js test process exited before readiness (${child.exitCode}).`)
    try {
      const response = await fetch(`${baseUrl}/api/internal/reamon/workspace/evidence`, { method: 'POST', body: '{}' })
      if (response.status === 401) return { child, baseUrl }
    } catch { /* the server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stopServer(child)
  throw new Error('Next.js test process did not become ready within 60 seconds.')
}

function agentHeaders(key: string, tool = 'workspace_list_evidence', contextUserId = userId) {
  const tag = signTag({
    source: 'agent', project_id: projectId, user_id: contextUserId, tool,
    exp: Math.floor(Date.now() / 1000) + 120,
  }, key)
  return { 'x-internal-key': key, 'x-redamon-ctx': tag, 'content-type': 'application/json' }
}

describe.skipIf(!HAS_DB)('agent Evidence HTTP paging across Next.js restart', () => {
  test('continues a persisted cursor after restart and key rotation, then keeps paging with the new key', async () => {
    let firstServer: ChildProcess | null = null
    let secondServer: ChildProcess | null = null
    try {
      const first = await startNextServer(INITIAL_KEY)
      firstServer = first.child

      const browserUrl = `${first.baseUrl}/api/projects/${projectId}/workspace/evidence?limit=1`
      const anonymousBrowserResponse = await fetch(browserUrl)
      expect(anonymousBrowserResponse.status).toBe(401)

      const foreignBrowserResponse = await fetch(browserUrl, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${foreignSessionCookie}` },
      })
      expect(foreignBrowserResponse.status).toBe(404)
      const foreignBrowserDetailResponse = await fetch(`${first.baseUrl}/api/projects/${projectId}/workspace/evidence/${evidenceId}`, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${foreignSessionCookie}` },
      })
      expect(foreignBrowserDetailResponse.status).toBe(404)

      const workspaceFilesUrl = `${first.baseUrl}/api/projects/${projectId}/workspace/files?limit=10`
      const anonymousWorkspaceFilesResponse = await fetch(workspaceFilesUrl)
      expect(anonymousWorkspaceFilesResponse.status).toBe(401)
      const foreignWorkspaceFilesResponse = await fetch(workspaceFilesUrl, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${foreignSessionCookie}` },
      })
      expect(foreignWorkspaceFilesResponse.status).toBe(404)
      const foreignWorkspaceArtifactResponse = await fetch(`${first.baseUrl}/api/projects/${projectId}/workspace/files/${artifactId}`, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${foreignSessionCookie}` },
      })
      expect(foreignWorkspaceArtifactResponse.status).toBe(404)
      const anonymousWorkspaceSnapshotResponse = await fetch(`${first.baseUrl}/api/projects/${projectId}/workspace`)
      expect(anonymousWorkspaceSnapshotResponse.status).toBe(401)
      const foreignWorkspaceSnapshotResponse = await fetch(`${first.baseUrl}/api/projects/${projectId}/workspace`, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${foreignSessionCookie}` },
      })
      expect(foreignWorkspaceSnapshotResponse.status).toBe(404)
      const foreignFindingReviewResponse = await fetch(`${first.baseUrl}/api/projects/${projectId}/workspace/findings/${findingId}`, {
        method: 'PATCH',
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${foreignSessionCookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ACCEPTED', note: 'foreign review must be rejected' }),
      })
      expect(foreignFindingReviewResponse.status).toBe(404)
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: findingId }, select: { status: true } })).status).toBe('OPEN')
      const ownerFindingReviewResponse = await fetch(`${first.baseUrl}/api/projects/${projectId}/workspace/findings/${findingId}`, {
        method: 'PATCH',
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${sessionCookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ACCEPTED', note: 'synthetic owner review' }),
      })
      expect(ownerFindingReviewResponse.status).toBe(200)
      expect(await ownerFindingReviewResponse.json()).toMatchObject({ finding: { id: findingId, status: 'ACCEPTED' }, note: 'synthetic owner review' })
      expect((await prisma.finding.findUniqueOrThrow({ where: { id: findingId }, select: { status: true } })).status).toBe('ACCEPTED')
      const ownerWorkspaceFilesResponse = await fetch(workspaceFilesUrl, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${sessionCookie}` },
      })
      expect(ownerWorkspaceFilesResponse.status).toBe(200)
      expect(await ownerWorkspaceFilesResponse.json()).toMatchObject({ artifacts: [{ id: artifactId, relativePath: 'bin/synthetic.exe' }], total: 1 })
      const ownerWorkspaceArtifactResponse = await fetch(`${first.baseUrl}/api/projects/${projectId}/workspace/files/${artifactId}`, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${sessionCookie}` },
      })
      expect(ownerWorkspaceArtifactResponse.status).toBe(200)
      expect(await ownerWorkspaceArtifactResponse.json()).toMatchObject({ id: artifactId, relativePath: 'bin/synthetic.exe', sha256: 'a'.repeat(64) })

      const foreignAgentResponse = await fetch(`${first.baseUrl}/api/internal/reamon/workspace/evidence`, {
        method: 'POST',
        headers: agentHeaders(INITIAL_KEY, 'workspace_list_evidence', foreignUserId),
        body: JSON.stringify({ tool: 'workspace_list_evidence', limit: 1 }),
      })
      expect(foreignAgentResponse.status).toBe(404)

      const browserFirstResponse = await fetch(browserUrl, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${sessionCookie}` },
      })
      expect(browserFirstResponse.status).toBe(200)
      expect(browserFirstResponse.headers.get('Cache-Control')).toBe('private, no-store')
      const browserFirstPage = await browserFirstResponse.json() as {
        evidence: Array<{ summary: string }>; nextCursor: string | null; total: number
      }
      expect(browserFirstPage).toMatchObject({ evidence: [{ summary: 'HTTP cursor record 1' }], total: 4 })
      expect(browserFirstPage.nextCursor).toEqual(expect.any(String))

      const firstResponse = await fetch(`${first.baseUrl}/api/internal/reamon/workspace/evidence`, {
        method: 'POST',
        headers: agentHeaders(INITIAL_KEY),
        body: JSON.stringify({ tool: 'workspace_list_evidence', limit: 1 }),
      })
      expect(firstResponse.status).toBe(200)
      const firstPage = await firstResponse.json() as { evidence: Array<{ summary: string }>; nextCursor: string; total: number }
      expect(firstPage).toMatchObject({ evidence: [{ summary: 'HTTP cursor record 1' }], total: 4 })
      expect(firstPage.nextCursor).toEqual(expect.any(String))

      await stopServer(firstServer)
      firstServer = null

      const second = await startNextServer(ROTATED_KEY, INITIAL_KEY)
      secondServer = second.child

      const browserNextUrl = `${second.baseUrl}/api/projects/${projectId}/workspace/evidence?limit=1&cursor=${encodeURIComponent(browserFirstPage.nextCursor as string)}`
      const browserNextResponse = await fetch(browserNextUrl, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${sessionCookie}` },
      })
      expect(browserNextResponse.status).toBe(200)
      const browserNextPage = await browserNextResponse.json() as {
        evidence: Array<{ summary: string }>; nextCursor: string | null; total: number
      }
      expect(browserNextPage).toMatchObject({ evidence: [{ summary: 'HTTP cursor record 2' }], total: 4 })
      expect(browserNextPage.nextCursor).toEqual(expect.any(String))
      const [browserPayload, browserSignature] = (browserNextPage.nextCursor as string).split('.')
      expect(browserSignature).toBe(createHmac('sha256', ROTATED_KEY).update(browserPayload).digest('base64url'))

      const browserLastUrl = `${second.baseUrl}/api/projects/${projectId}/workspace/evidence?limit=1&cursor=${encodeURIComponent(browserNextPage.nextCursor as string)}`
      const browserLastResponse = await fetch(browserLastUrl, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${sessionCookie}` },
      })
      expect(browserLastResponse.status).toBe(200)
      const browserLastPage = await browserLastResponse.json() as {
        evidence: Array<{ summary: string }>; nextCursor: string | null; total: number
      }
      expect(browserLastPage).toMatchObject({ evidence: [{ summary: 'HTTP cursor record 3' }], total: 4 })
      expect(browserLastPage.nextCursor).toEqual(expect.any(String))

      const browserFinalUrl = `${second.baseUrl}/api/projects/${projectId}/workspace/evidence?limit=1&cursor=${encodeURIComponent(browserLastPage.nextCursor as string)}`
      const browserFinalResponse = await fetch(browserFinalUrl, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${sessionCookie}` },
      })
      expect(browserFinalResponse.status).toBe(200)
      const browserFinalPage = await browserFinalResponse.json() as {
        evidence: Array<{ summary: string }>; nextCursor: string | null; total: number
      }
      expect(browserFinalPage).toMatchObject({ evidence: [{ summary: 'HTTP cursor record 4' }], total: 4, nextCursor: null })

      const secondResponse = await fetch(`${second.baseUrl}/api/internal/reamon/workspace/evidence`, {
        method: 'POST',
        headers: agentHeaders(ROTATED_KEY),
        body: JSON.stringify({ tool: 'workspace_list_evidence', limit: 1, cursor: firstPage.nextCursor }),
      })
      expect(secondResponse.status).toBe(200)
      const secondPage = await secondResponse.json() as { evidence: Array<{ summary: string }>; nextCursor: string; total: number }
      expect(secondPage).toMatchObject({ evidence: [{ summary: 'HTTP cursor record 2' }], total: 4 })
      expect(secondPage.nextCursor).toEqual(expect.any(String))
      const [payload, signature] = secondPage.nextCursor.split('.')
      expect(signature).toBe(createHmac('sha256', ROTATED_KEY).update(payload).digest('base64url'))

      const thirdResponse = await fetch(`${second.baseUrl}/api/internal/reamon/workspace/evidence`, {
        method: 'POST',
        headers: agentHeaders(ROTATED_KEY),
        body: JSON.stringify({ tool: 'workspace_list_evidence', limit: 1, cursor: secondPage.nextCursor }),
      })
      expect(thirdResponse.status).toBe(200)
      const thirdPage = await thirdResponse.json() as { evidence: Array<{ summary: string }>; nextCursor: string | null; total: number }
      expect(thirdPage).toMatchObject({ evidence: [{ summary: 'HTTP cursor record 3' }], total: 4 })
      expect(thirdPage.nextCursor).toEqual(expect.any(String))

      const fourthResponse = await fetch(`${second.baseUrl}/api/internal/reamon/workspace/evidence`, {
        method: 'POST',
        headers: agentHeaders(ROTATED_KEY),
        body: JSON.stringify({ tool: 'workspace_list_evidence', limit: 1, cursor: thirdPage.nextCursor }),
      })
      expect(fourthResponse.status).toBe(200)
      const fourthPage = await fourthResponse.json() as { evidence: Array<{ summary: string }>; nextCursor: string | null; total: number }
      expect(fourthPage).toMatchObject({ evidence: [{ summary: 'HTTP cursor record 4' }], total: 4, nextCursor: null })
    } finally {
      await stopServer(secondServer)
      await stopServer(firstServer)
    }
  }, 180_000)

  test('keeps both Next.js instances interoperable during an overlapping key rotation', async () => {
    let oldServer: ChildProcess | null = null
    let rotatedServer: ChildProcess | null = null
    try {
      const old = await startNextServer(INITIAL_KEY, ROTATED_KEY)
      oldServer = old.child
      const firstResponse = await fetch(`${old.baseUrl}/api/projects/${projectId}/workspace/evidence?limit=1`, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${sessionCookie}` },
      })
      expect(firstResponse.status).toBe(200)
      const firstPage = await firstResponse.json() as { evidence: Array<{ summary: string }>; nextCursor: string; total: number }
      expect(firstPage).toMatchObject({ evidence: [{ summary: 'HTTP cursor record 1' }], total: 4 })
      expect(firstPage.nextCursor).toEqual(expect.any(String))

      const rotated = await startNextServer(ROTATED_KEY, INITIAL_KEY)
      rotatedServer = rotated.child
      const rotatedHeaders = agentHeaders(ROTATED_KEY)
      const secondResponse = await fetch(`${rotated.baseUrl}/api/internal/reamon/workspace/evidence`, {
        method: 'POST', headers: rotatedHeaders,
        body: JSON.stringify({ tool: 'workspace_list_evidence', limit: 1, cursor: firstPage.nextCursor }),
      })
      expect(secondResponse.status).toBe(200)
      const secondPage = await secondResponse.json() as { evidence: Array<{ summary: string }>; nextCursor: string; total: number }
      expect(secondPage).toMatchObject({ evidence: [{ summary: 'HTTP cursor record 2' }], total: 4 })
      const [secondPayload, secondSignature] = secondPage.nextCursor.split('.')
      expect(secondSignature).toBe(createHmac('sha256', ROTATED_KEY).update(secondPayload).digest('base64url'))

      const thirdResponse = await fetch(`${old.baseUrl}/api/projects/${projectId}/workspace/evidence?limit=1&cursor=${encodeURIComponent(secondPage.nextCursor)}`, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${sessionCookie}` },
      })
      expect(thirdResponse.status).toBe(200)
      const thirdPage = await thirdResponse.json() as { evidence: Array<{ summary: string }>; nextCursor: string; total: number }
      expect(thirdPage).toMatchObject({ evidence: [{ summary: 'HTTP cursor record 3' }], total: 4 })
      const [thirdPayload, thirdSignature] = thirdPage.nextCursor.split('.')
      expect(thirdSignature).toBe(createHmac('sha256', INITIAL_KEY).update(thirdPayload).digest('base64url'))

      const fourthResponse = await fetch(`${rotated.baseUrl}/api/internal/reamon/workspace/evidence`, {
        method: 'POST', headers: rotatedHeaders,
        body: JSON.stringify({ tool: 'workspace_list_evidence', limit: 1, cursor: thirdPage.nextCursor }),
      })
      expect(fourthResponse.status).toBe(200)
      const fourthPage = await fourthResponse.json() as { evidence: Array<{ summary: string }>; nextCursor: string | null; total: number }
      expect(fourthPage).toMatchObject({ evidence: [{ summary: 'HTTP cursor record 4' }], total: 4, nextCursor: null })
    } finally {
      await stopServer(rotatedServer)
      await stopServer(oldServer)
    }
  }, 180_000)

  test.each([
    ['default active signing key', 'changeme', ''],
    ['more than three previous signing keys', INITIAL_KEY, 'rotation-a,rotation-b,rotation-c,rotation-d'],
  ])('fails closed over HTTP for %s', async (_caseName, activeKey, previousKeys) => {
    let server: ChildProcess | null = null
    try {
      const running = await startNextServer(activeKey, previousKeys)
      server = running.child
      const response = await fetch(`${running.baseUrl}/api/projects/${projectId}/workspace/evidence?limit=1`, {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${sessionCookie}` },
      })
      expect(response.status).toBe(503)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      expect(await response.json()).toMatchObject({ error: { code: 'cursor_unavailable' } })
    } finally {
      await stopServer(server)
    }
  }, 180_000)
})

/** @vitest-environment node */
/** PostgreSQL-backed HTTP acceptance for deobfuscation project ownership. */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { AUTH_COOKIE_NAME, createToken } from '@/lib/auth'

const HAS_DB = Boolean(process.env.DATABASE_URL)
const SUFFIX = `deobfuscation-ownership-${randomUUID()}`
const AUTH_SECRET = 'deobfuscation-ownership-http-integration-secret'
const AGENT_BATCH_ID = `agent-${randomUUID()}`
const SOURCE_HASH = 'a'.repeat(64)

let prisma: PrismaClient | undefined
let ownerId = ''
let foreignId = ''
let projectId = ''
let artifactId = ''
let taskId = ''
let batchAttemptId = ''
let singleAttemptId = ''
let ownerCookie = ''
let foreignCookie = ''
let server: ChildProcess | null = null
let baseUrl = ''
let originalAuthSecret: string | undefined
let originalAccessEnforce: string | undefined

beforeAll(async () => {
  originalAuthSecret = process.env.AUTH_SECRET
  originalAccessEnforce = process.env.ACCESS_ENFORCE
  if (!HAS_DB) return
  process.env.AUTH_SECRET = AUTH_SECRET
  process.env.ACCESS_ENFORCE = '0'

  prisma = new PrismaClient()
  const owner = await prisma.user.create({
    data: { email: `${SUFFIX}@example.invalid`, name: 'deobfuscation owner' },
    select: { id: true },
  })
  ownerId = owner.id
  const foreign = await prisma.user.create({
    data: { email: `${SUFFIX}-foreign@example.invalid`, name: 'deobfuscation foreign user' },
    select: { id: true },
  })
  foreignId = foreign.id
  const project = await prisma.project.create({
    data: { name: 'deobfuscation ownership HTTP integration', userId: ownerId },
    select: { id: true },
  })
  projectId = project.id
  const artifact = await prisma.artifact.create({
    data: {
      projectId,
      name: 'deobfuscation-ownership.bin',
      originalName: 'deobfuscation-ownership.bin',
      storagePath: 'synthetic-integration-fixture',
      sha256: SOURCE_HASH,
      sizeBytes: BigInt(1),
      extension: '.bin',
    },
    select: { id: true },
  })
  artifactId = artifact.id
  const task = await prisma.task.create({
    data: {
      projectId,
      artifactId,
      capability: 'decompile',
      title: 'deobfuscation ownership fixture',
      status: 'COMPLETED',
    },
    select: { id: true },
  })
  taskId = task.id
  const runKey = `${projectId}/${artifactId}/${taskId}/run-1`
  const batchAttempt = await prisma.reamonCodeAttempt.create({
    data: {
      projectId,
      artifactId,
      runKey,
      codeUnitId: `${SUFFIX}-batch-unit`,
      unitName: 'batchUnit',
      language: 'C',
      sourceHash: SOURCE_HASH,
      providerName: 'synthetic-fixture',
      modelIdentifier: 'synthetic-fixture',
      scope: 'member',
      agentBatchId: AGENT_BATCH_ID,
      status: 'QUEUED',
      requestPayload: { member_name: 'batchUnit' },
    },
    select: { id: true },
  })
  batchAttemptId = batchAttempt.id
  const singleAttempt = await prisma.reamonCodeAttempt.create({
    data: {
      projectId,
      artifactId,
      runKey,
      codeUnitId: `${SUFFIX}-single-unit`,
      unitName: 'singleUnit',
      language: 'C',
      sourceHash: SOURCE_HASH,
      providerName: 'synthetic-fixture',
      modelIdentifier: 'synthetic-fixture',
      scope: 'member',
      status: 'QUEUED',
      requestPayload: { source_code: 'int singleUnit(void) { return 1; }' },
    },
    select: { id: true },
  })
  singleAttemptId = singleAttempt.id

  ownerCookie = `${AUTH_COOKIE_NAME}=${await createToken(ownerId, 'standard')}`
  foreignCookie = `${AUTH_COOKIE_NAME}=${await createToken(foreignId, 'standard')}`
  const port = await availablePort()
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [
    './node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', String(port),
  ], {
    cwd: process.cwd(),
    stdio: 'ignore',
    env: {
      ...process.env,
      AUTH_SECRET,
      ACCESS_ENFORCE: '0',
      REAMON_NEXT_TEST_DIST_DIR: `.next-deobfuscation-ownership-${port}`,
    },
  })

  const readinessUrl = `${baseUrl}/api/projects/${projectId}/visualizer/deobfuscate/batches?taskId=${taskId}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js deobfuscation ownership process exited before readiness (${server.exitCode}).`)
    try {
      if ((await fetch(readinessUrl)).status === 401) return
    } catch { /* the server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stopServer(server)
  server = null
  throw new Error('Next.js deobfuscation ownership process did not become ready within 60 seconds.')
}, 90_000)

afterAll(async () => {
  await stopServer(server)
  if (prisma) {
    try {
      if (projectId) {
        await prisma.reamonCodeAttempt.deleteMany({ where: { projectId } })
        await prisma.task.deleteMany({ where: { projectId } })
        await prisma.artifact.deleteMany({ where: { projectId } })
        await prisma.project.deleteMany({ where: { id: projectId, userId: ownerId } })
        expect(await prisma.project.count({ where: { id: projectId } })).toBe(0)
      }
      if (ownerId) {
        await prisma.user.deleteMany({ where: { id: ownerId } })
        expect(await prisma.user.count({ where: { id: ownerId } })).toBe(0)
      }
      if (foreignId) {
        await prisma.user.deleteMany({ where: { id: foreignId } })
        expect(await prisma.user.count({ where: { id: foreignId } })).toBe(0)
      }
      if (batchAttemptId) expect(await prisma.reamonCodeAttempt.count({ where: { id: batchAttemptId } })).toBe(0)
      if (singleAttemptId) expect(await prisma.reamonCodeAttempt.count({ where: { id: singleAttemptId } })).toBe(0)
    } finally {
      await prisma.$disconnect()
    }
  }
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = originalAuthSecret
  if (originalAccessEnforce === undefined) delete process.env.ACCESS_ENFORCE
  else process.env.ACCESS_ENFORCE = originalAccessEnforce
})

async function availablePort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local port.')
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
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

function api(pathname: string) { return `${baseUrl}${pathname}` }
function projectPath(suffix: string) { return `/api/projects/${projectId}/visualizer/deobfuscate${suffix}` }
function auth(cookie?: string) { return cookie ? { cookie } : {} }

describe.skipIf(!HAS_DB)('deobfuscation HTTP ownership with ACCESS_ENFORCE=0', () => {
  test('rewrite submission is owner-only before unit lookup or provider work', async () => {
    const url = api(projectPath(''))
    const body = JSON.stringify({ unitId: `${SUFFIX}-missing-unit`, providerId: 'synthetic-provider', scope: 'file' })
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body }

    expect((await fetch(url, init)).status).toBe(401)
    const foreign = await fetch(url, { ...init, headers: { ...init.headers, ...auth(foreignCookie) } })
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual({ error: 'Not found' })

    const owner = await fetch(url, { ...init, headers: { ...init.headers, ...auth(ownerCookie) } })
    expect(owner.status).toBe(404)
    expect(await owner.json()).toEqual({ error: 'Code unit not found' })
    expect(await prisma?.reamonCodeAttempt.count({ where: { projectId } })).toBe(2)
  }, 60_000)

  test('batch history and cancellation deny foreign users without hiding owner access', async () => {
    const historyUrl = api(projectPath(`/batches?taskId=${taskId}`))
    expect((await fetch(historyUrl)).status).toBe(401)
    const foreignHistory = await fetch(historyUrl, { headers: auth(foreignCookie) })
    expect(foreignHistory.status).toBe(404)
    expect(await foreignHistory.json()).toEqual({ error: 'Not found' })

    const ownerHistory = await fetch(historyUrl, { headers: auth(ownerCookie) })
    expect(ownerHistory.status).toBe(200)
    expect(await ownerHistory.json()).toMatchObject({ batch: { id: AGENT_BATCH_ID, attempts: [{ id: batchAttemptId, status: 'QUEUED' }] } })

    const cancelUrl = api(projectPath(`/batches/${AGENT_BATCH_ID}/cancel`))
    expect((await fetch(cancelUrl, { method: 'POST' })).status).toBe(401)
    const foreignCancel = await fetch(cancelUrl, { method: 'POST', headers: auth(foreignCookie) })
    expect(foreignCancel.status).toBe(404)
    expect(await foreignCancel.json()).toEqual({ error: 'Not found' })
    expect((await prisma?.reamonCodeAttempt.findUnique({ where: { id: batchAttemptId }, select: { status: true } }))?.status).toBe('QUEUED')

    const ownerCancel = await fetch(cancelUrl, { method: 'POST', headers: auth(ownerCookie) })
    expect(ownerCancel.status).toBe(200)
    expect(await ownerCancel.json()).toMatchObject({ batchId: AGENT_BATCH_ID, cancelledQueued: 1, remaining: 0 })
    expect((await prisma?.reamonCodeAttempt.findUnique({ where: { id: batchAttemptId }, select: { status: true } }))?.status).toBe('CANCELLED')
  }, 60_000)

  test('attempt status and cancellation deny foreign users without exposing or mutating attempts', async () => {
    const statusUrl = api(projectPath(`/attempts/${singleAttemptId}`))
    expect((await fetch(statusUrl)).status).toBe(401)
    const foreignStatus = await fetch(statusUrl, { headers: auth(foreignCookie) })
    expect(foreignStatus.status).toBe(404)
    expect(await foreignStatus.json()).toEqual({ error: 'Not found' })
    expect((await prisma?.reamonCodeAttempt.findUnique({ where: { id: singleAttemptId }, select: { status: true } }))?.status).toBe('QUEUED')

    const ownerStatus = await fetch(statusUrl, { headers: auth(ownerCookie) })
    expect(ownerStatus.status).toBe(200)
    expect(await ownerStatus.json()).toMatchObject({ attemptId: singleAttemptId, status: 'QUEUED', cancelRequested: false })

    const cancelUrl = api(projectPath(`/attempts/${singleAttemptId}/cancel`))
    expect((await fetch(cancelUrl, { method: 'POST' })).status).toBe(401)
    const foreignCancel = await fetch(cancelUrl, { method: 'POST', headers: auth(foreignCookie) })
    expect(foreignCancel.status).toBe(404)
    expect(await foreignCancel.json()).toEqual({ error: 'Not found' })
    expect((await prisma?.reamonCodeAttempt.findUnique({ where: { id: singleAttemptId }, select: { status: true, cancelRequested: true } }))).toMatchObject({ status: 'QUEUED', cancelRequested: false })

    const ownerCancel = await fetch(cancelUrl, { method: 'POST', headers: auth(ownerCookie) })
    expect(ownerCancel.status).toBe(200)
    expect(await ownerCancel.json()).toMatchObject({ attemptId: singleAttemptId, status: 'CANCELLED' })
    expect((await prisma?.reamonCodeAttempt.findUnique({ where: { id: singleAttemptId }, select: { status: true } }))?.status).toBe('CANCELLED')
  }, 60_000)
})

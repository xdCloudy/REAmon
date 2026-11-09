/** @vitest-environment node */
/**
 * PostgreSQL-backed HTTP acceptance for task approval read/decision isolation.
 * Uses a synthetic awaiting-approval task and skips without DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'

import { AUTH_COOKIE_NAME, createToken } from '@/lib/auth'

const HAS_DB = process.env.DATABASE_URL !== undefined
const SUFFIX = `task-approvals-http-${Date.now()}`
const AUTH_SECRET = 'task-approvals-http-integration-secret'

let prisma: PrismaClient | undefined
let ownerId = ''
let foreignId = ''
let projectId = ''
let taskId = ''
let approvalId = ''
let ownerCookie = ''
let foreignCookie = ''
let server: ChildProcess | null = null
let baseUrl = ''
let originalAuthSecret: string | undefined
let originalAccessEnforce: string | undefined

beforeAll(async () => {
  if (!HAS_DB) return
  originalAuthSecret = process.env.AUTH_SECRET
  originalAccessEnforce = process.env.ACCESS_ENFORCE
  process.env.AUTH_SECRET = AUTH_SECRET
  process.env.ACCESS_ENFORCE = '0'

  prisma = new PrismaClient()
  const owner = await prisma.user.create({
    data: { email: `${SUFFIX}@example.invalid`, name: 'task approval owner' },
  })
  ownerId = owner.id
  const foreign = await prisma.user.create({
    data: { email: `${SUFFIX}-foreign@example.invalid`, name: 'task approval foreign user' },
  })
  foreignId = foreign.id
  const project = await prisma.project.create({
    data: { name: 'task approvals HTTP integration', userId: ownerId, targetDomain: 'task-approvals.example.invalid' },
  })
  projectId = project.id
  const task = await prisma.task.create({
    data: { projectId, title: 'Synthetic approval integration task', status: 'AWAITING_APPROVAL' },
  })
  taskId = task.id
  const approval = await prisma.reamonApproval.create({
    data: { projectId, taskId, status: 'PENDING', requestedBy: 'integration fixture' },
  })
  approvalId = approval.id

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
      REAMON_NEXT_TEST_DIST_DIR: `.next-task-approvals-${port}`,
    },
  })

  const url = `${baseUrl}/api/projects/${projectId}/approvals`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js test process exited before readiness (${server.exitCode}).`)
    try {
      if ((await fetch(url)).status === 401) return
    } catch { /* the server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stopServer(server)
  server = null
  throw new Error('Next.js task approvals test process did not become ready within 60 seconds.')
}, 90_000)

afterAll(async () => {
  await stopServer(server)
  if (prisma) {
    try {
      if (projectId) {
        await prisma.project.deleteMany({ where: { id: projectId } })
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
      if (taskId) expect(await prisma.task.count({ where: { id: taskId } })).toBe(0)
      if (approvalId) expect(await prisma.reamonApproval.count({ where: { id: approvalId } })).toBe(0)
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
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local test port.')
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

describe.skipIf(!HAS_DB)('project task-approval HTTP ownership', () => {
  test('owner can inspect and reject while anonymous and foreign callers cannot access or decide', async () => {
    const base = `${baseUrl}/api/projects/${projectId}/approvals`
    const decisionUrl = `${base}/${approvalId}`
    const reject = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'reject', reason: 'synthetic denial check' }) }

    expect((await fetch(base)).status).toBe(401)
    expect((await fetch(decisionUrl, reject)).status).toBe(401)

    const foreignRead = await fetch(base, { headers: { cookie: foreignCookie } })
    expect(foreignRead.status).toBe(404)
    const foreignDecision = await fetch(decisionUrl, { ...reject, headers: { ...reject.headers, cookie: foreignCookie } })
    expect(foreignDecision.status).toBe(404)
    expect(await prisma!.reamonApproval.findUnique({ where: { id: approvalId } })).toMatchObject({ status: 'PENDING' })
    expect(await prisma!.task.findUnique({ where: { id: taskId } })).toMatchObject({ status: 'AWAITING_APPROVAL' })

    const ownerRead = await fetch(base, { headers: { cookie: ownerCookie } })
    expect(ownerRead.status).toBe(200)
    expect(await ownerRead.json()).toMatchObject({ approvals: [{ approval: { id: approvalId, status: 'PENDING' }, task: { id: taskId, status: 'AWAITING_APPROVAL' } }] })

    const ownerDecision = await fetch(decisionUrl, { ...reject, headers: { ...reject.headers, cookie: ownerCookie } })
    expect(ownerDecision.status).toBe(200)
    expect(await ownerDecision.json()).toMatchObject({ decision: 'reject', approval: { status: 'REJECTED' }, task: { status: 'CANCELLED' } })
    expect(await prisma!.reamonApproval.findUnique({ where: { id: approvalId } })).toMatchObject({ status: 'REJECTED', decidedBy: ownerId })
    expect(await prisma!.task.findUnique({ where: { id: taskId } })).toMatchObject({ status: 'CANCELLED' })
  }, 60_000)
})

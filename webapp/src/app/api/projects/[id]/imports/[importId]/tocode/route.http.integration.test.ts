/** @vitest-environment node */
/** PostgreSQL-backed HTTP acceptance for ToCode import ownership. */
import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'

import { AUTH_COOKIE_NAME, createToken } from '@/lib/auth'

const HAS_DB = process.env.DATABASE_URL !== undefined
const SUFFIX = `tocode-import-http-${Date.now()}`
const AUTH_SECRET = 'tocode-import-http-integration-secret'

let prisma: PrismaClient | undefined
let ownerId = ''
let foreignId = ''
let projectId = ''
let importId = ''
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
  const owner = await prisma.user.create({ data: { email: `${SUFFIX}@example.invalid`, name: 'ToCode import owner' } })
  ownerId = owner.id
  const foreign = await prisma.user.create({ data: { email: `${SUFFIX}-foreign@example.invalid`, name: 'ToCode import foreign user' } })
  foreignId = foreign.id
  const project = await prisma.project.create({ data: { name: 'ToCode import HTTP integration', userId: ownerId } })
  projectId = project.id
  const workspaceImport = await prisma.workspaceImport.create({
    data: {
      projectId,
      rootName: `synthetic-${SUFFIX}`,
      sourceType: 'BROWSER_DIRECTORY',
      status: 'COMPLETED',
      totalFiles: 0,
      manifest: [],
    },
  })
  importId = workspaceImport.id
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
      REAMON_NEXT_TEST_DIST_DIR: `.next-tocode-import-${port}`,
    },
  })

  const url = toCodeUrl()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js ToCode-import test process exited before readiness (${server.exitCode}).`)
    try {
      if ((await fetch(url, { method: 'POST' })).status === 401) return
    } catch { /* server is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stopServer(server)
  server = null
  throw new Error('Next.js ToCode-import test process did not become ready within 60 seconds.')
}, 90_000)

afterAll(async () => {
  await stopServer(server)
  if (prisma) {
    try {
      if (projectId) {
        await prisma.project.deleteMany({ where: { id: projectId } })
        expect(await prisma.project.count({ where: { id: projectId } })).toBe(0)
      }
      if (importId) expect(await prisma.workspaceImport.count({ where: { id: importId } })).toBe(0)
      if (ownerId) {
        await prisma.user.deleteMany({ where: { id: ownerId } })
        expect(await prisma.user.count({ where: { id: ownerId } })).toBe(0)
      }
      if (foreignId) {
        await prisma.user.deleteMany({ where: { id: foreignId } })
        expect(await prisma.user.count({ where: { id: foreignId } })).toBe(0)
      }
    } finally {
      await prisma.$disconnect()
    }
  }
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = originalAuthSecret
  if (originalAccessEnforce === undefined) delete process.env.ACCESS_ENFORCE
  else process.env.ACCESS_ENFORCE = originalAccessEnforce
})

function toCodeUrl() {
  return `${baseUrl}/api/projects/${projectId}/imports/${importId}/tocode`
}

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

describe.skipIf(!HAS_DB)('ToCode import HTTP ownership', () => {
  test('foreign users cannot start indexing under ACCESS_ENFORCE=0', async () => {
    const url = toCodeUrl()
    expect((await fetch(url, { method: 'POST' })).status).toBe(401)

    const foreign = await fetch(url, { method: 'POST', headers: { cookie: foreignCookie } })
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual({ error: 'Not found' })
    expect(await prisma!.workspaceImport.findUnique({ where: { id: importId }, select: { status: true } }))
      .toMatchObject({ status: 'COMPLETED' })
    expect(await prisma!.artifact.count({ where: { projectId, importId } })).toBe(0)
    expect(await prisma!.workspaceActivity.count({ where: { projectId } })).toBe(0)

    const owner = await fetch(url, { method: 'POST', headers: { cookie: ownerCookie } })
    expect(owner.status).toBe(400)
    expect(await owner.json()).toEqual({ error: 'This workspace import does not contain a ToCode export' })
  }, 60_000)
})

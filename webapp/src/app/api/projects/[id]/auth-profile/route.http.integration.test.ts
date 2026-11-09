/** @vitest-environment node */
/**
 * Live HTTP acceptance for the project auth-profile boundary. This uses a
 * disposable PostgreSQL project and a separate Next.js process, and skips when
 * DATABASE_URL is not configured.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'

import { AUTH_COOKIE_NAME, createToken } from '@/lib/auth'

const HAS_DB = process.env.DATABASE_URL !== undefined
const SUFFIX = `auth-profile-http-${Date.now()}`
const AUTH_SECRET = 'auth-profile-http-integration-secret'
const PROFILE_SECRET = 'sid=auth-profile-http-secret'

let prisma: PrismaClient | undefined
let ownerId = ''
let foreignId = ''
let projectId = ''
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
    data: { email: `${SUFFIX}@example.invalid`, name: 'auth-profile owner' },
  })
  ownerId = owner.id
  const foreign = await prisma.user.create({
    data: { email: `${SUFFIX}-foreign@example.invalid`, name: 'auth-profile foreign user' },
  })
  foreignId = foreign.id
  const project = await prisma.project.create({
    data: { name: 'auth-profile HTTP integration', userId: ownerId, targetDomain: 'auth-profile.example.invalid' },
  })
  projectId = project.id
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
      REAMON_NEXT_TEST_DIST_DIR: `.next-auth-profile-${port}`,
    },
  })

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js test process exited before readiness (${server.exitCode}).`)
    try {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/auth-profile`)
      if (response.status === 401) return
    } catch { /* the server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stopServer(server)
  server = null
  throw new Error('Next.js auth-profile test process did not become ready within 60 seconds.')
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

function requestOptions(cookie?: string, method = 'GET', body?: unknown): RequestInit {
  return {
    method,
    ...(cookie ? { headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
}

describe.skipIf(!HAS_DB)('project auth-profile HTTP ownership', () => {
  test('owner can read/write/delete while anonymous and foreign users stay blocked with ACCESS_ENFORCE=0', async () => {
    const url = `${baseUrl}/api/projects/${projectId}/auth-profile`

    const anonymousStatuses = await Promise.all([
      fetch(url),
      fetch(url, requestOptions(undefined, 'PUT', { authType: 'cookie', authValue: PROFILE_SECRET })),
      fetch(url, requestOptions(undefined, 'DELETE')),
    ]).then(async (responses) => Promise.all(responses.map(async (response) => response.status)))
    expect(anonymousStatuses).toEqual([401, 401, 401])
    expect(await prisma!.projectAuthProfile.count({ where: { projectId } })).toBe(0)

    const ownerRead = await fetch(url, requestOptions(ownerCookie))
    expect(ownerRead.status).toBe(200)
    expect(await ownerRead.json()).toEqual({ authProfile: null })

    const ownerWrite = await fetch(url, requestOptions(ownerCookie, 'PUT', {
      authType: 'cookie', authValue: PROFILE_SECRET, scopeHosts: ['auth-profile.example.invalid'],
    }))
    expect(ownerWrite.status).toBe(200)
    expect(await ownerWrite.text()).not.toContain(PROFILE_SECRET)
    expect(await prisma!.projectAuthProfile.findUnique({ where: { projectId } })).toMatchObject({
      projectId, userId: ownerId, authValue: PROFILE_SECRET, source: 'manual', status: 'unknown',
    })

    const foreignStatuses = await Promise.all([
      fetch(url, requestOptions(foreignCookie)),
      fetch(url, requestOptions(foreignCookie, 'PUT', { authType: 'cookie', authValue: 'sid=foreign-write' })),
      fetch(url, requestOptions(foreignCookie, 'DELETE')),
    ]).then(async (responses) => Promise.all(responses.map(async (response) => response.status)))
    expect(foreignStatuses).toEqual([404, 404, 404])
    expect(await prisma!.projectAuthProfile.findUnique({ where: { projectId } })).toMatchObject({
      projectId, userId: ownerId, authValue: PROFILE_SECRET,
    })

    const ownerDelete = await fetch(url, requestOptions(ownerCookie, 'DELETE'))
    expect(ownerDelete.status).toBe(200)
    expect(await ownerDelete.json()).toEqual({ authProfile: null })
    expect(await prisma!.projectAuthProfile.count({ where: { projectId } })).toBe(0)
  }, 60_000)
})

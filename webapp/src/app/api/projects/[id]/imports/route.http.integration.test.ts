/** @vitest-environment node */
/** PostgreSQL-backed HTTP acceptance for workspace import collection ownership. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'

import { AUTH_COOKIE_NAME, createToken } from '@/lib/auth'

const HAS_DB = process.env.DATABASE_URL !== undefined
const SUFFIX = `workspace-import-collection-http-${Date.now()}`
const AUTH_SECRET = 'workspace-import-collection-http-secret'
const ROOT_NAME = `synthetic-${SUFFIX}`
const FILES = [{ relativePath: 'src/Main.java', size: 4, lastModified: null }]

let prisma: PrismaClient | undefined
let ownerId = ''
let foreignId = ''
let projectId = ''
let artifactsRoot = ''
let ownerCookie = ''
let foreignCookie = ''
let server: ChildProcess | null = null
let baseUrl = ''
let originalAuthSecret: string | undefined
let originalAccessEnforce: string | undefined
let originalArtifactsPath: string | undefined

beforeAll(async () => {
  originalAuthSecret = process.env.AUTH_SECRET
  originalAccessEnforce = process.env.ACCESS_ENFORCE
  originalArtifactsPath = process.env.REAMON_ARTIFACTS_PATH
  if (!HAS_DB) return
  process.env.AUTH_SECRET = AUTH_SECRET
  process.env.ACCESS_ENFORCE = '0'

  prisma = new PrismaClient()
  const owner = await prisma.user.create({
    data: { email: `${SUFFIX}@example.invalid`, name: 'workspace import owner' },
  })
  ownerId = owner.id
  const foreign = await prisma.user.create({
    data: { email: `${SUFFIX}-foreign@example.invalid`, name: 'workspace import foreign user' },
  })
  foreignId = foreign.id
  const project = await prisma.project.create({ data: { name: 'workspace import collection HTTP integration', userId: ownerId } })
  projectId = project.id

  artifactsRoot = await mkdtemp(join(tmpdir(), `${SUFFIX}-`))
  process.env.REAMON_ARTIFACTS_PATH = artifactsRoot
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
      REAMON_ARTIFACTS_PATH: artifactsRoot,
      REAMON_NEXT_TEST_DIST_DIR: `.next-workspace-import-collection-${port}`,
    },
  })

  const url = `${baseUrl}/api/projects/${projectId}/imports`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js workspace-import test process exited before readiness (${server.exitCode}).`)
    try {
      if ((await fetch(url)).status === 401) return
    } catch { /* server is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stopServer(server)
  server = null
  throw new Error('Next.js workspace-import test process did not become ready within 60 seconds.')
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
      if (projectId) {
        expect(await prisma.workspaceImport.count({ where: { projectId } })).toBe(0)
        expect(await prisma.target.count({ where: { projectId } })).toBe(0)
        expect(await prisma.workspaceActivity.count({ where: { projectId } })).toBe(0)
      }
    } finally {
      await prisma.$disconnect()
    }
  }
  if (artifactsRoot) await rm(artifactsRoot, { recursive: true, force: true })
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = originalAuthSecret
  if (originalAccessEnforce === undefined) delete process.env.ACCESS_ENFORCE
  else process.env.ACCESS_ENFORCE = originalAccessEnforce
  if (originalArtifactsPath === undefined) delete process.env.REAMON_ARTIFACTS_PATH
  else process.env.REAMON_ARTIFACTS_PATH = originalArtifactsPath
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

describe.skipIf(!HAS_DB)('workspace import collection HTTP ownership', () => {
  test('foreign users cannot read limits or create imports under ACCESS_ENFORCE=0', async () => {
    const url = `${baseUrl}/api/projects/${projectId}/imports`
    const body = JSON.stringify({ rootName: ROOT_NAME, sourceType: 'BROWSER_DIRECTORY', files: FILES })
    const post = { method: 'POST', headers: { 'content-type': 'application/json' }, body }

    expect((await fetch(url)).status).toBe(401)
    expect((await fetch(url, post)).status).toBe(401)
    const foreignGet = await fetch(url, { headers: { cookie: foreignCookie } })
    expect(foreignGet.status).toBe(404)
    expect(await foreignGet.json()).toEqual({ error: 'Not found' })
    const foreignPost = await fetch(url, { ...post, headers: { ...post.headers, cookie: foreignCookie } })
    expect(foreignPost.status).toBe(404)
    expect(await foreignPost.json()).toEqual({ error: 'Not found' })
    expect(await prisma!.workspaceImport.count({ where: { projectId } })).toBe(0)
    expect(await prisma!.target.count({ where: { projectId } })).toBe(0)
    expect(await prisma!.workspaceActivity.count({ where: { projectId } })).toBe(0)

    const ownerGet = await fetch(url, { headers: { cookie: ownerCookie } })
    expect(ownerGet.status).toBe(200)
    expect(await ownerGet.json()).toMatchObject({ storage: { available: true } })
    const ownerPost = await fetch(url, { ...post, headers: { ...post.headers, cookie: ownerCookie } })
    expect(ownerPost.status).toBe(201)
    const result = await ownerPost.json()
    expect(result).toMatchObject({ rootName: ROOT_NAME, sourceType: 'BROWSER_DIRECTORY', totalFiles: 1, totalBytes: 4 })

    const stored = await prisma!.workspaceImport.findFirst({ where: { id: result.id, projectId } })
    expect(stored).toMatchObject({ rootName: ROOT_NAME, status: 'PENDING', totalFiles: 1, totalBytes: 4n })
    expect(await prisma!.target.count({ where: { projectId } })).toBe(1)
    expect(await prisma!.workspaceActivity.count({ where: { projectId, eventType: 'workspace.import.created' } })).toBe(1)
  }, 60_000)
})

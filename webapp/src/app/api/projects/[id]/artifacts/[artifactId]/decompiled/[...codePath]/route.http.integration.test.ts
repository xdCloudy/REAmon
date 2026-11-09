/** @vitest-environment node */
/**
 * PostgreSQL-backed HTTP acceptance for decompiled-source project ownership.
 * Uses synthetic records and skips when DATABASE_URL is unavailable.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'

import { AUTH_COOKIE_NAME, createToken } from '@/lib/auth'

const HAS_DB = process.env.DATABASE_URL !== undefined
const SUFFIX = `decompiled-source-http-${Date.now()}`
const AUTH_SECRET = 'decompiled-source-http-integration-secret'
const RELATIVE_PATH = (projectId: string, artifactId: string) => `${projectId}/${artifactId}/task-1/run-1/sources/Main.java`
const SOURCE = 'package sample;\nclass Main { int answer() { return 42; } }\n'
const SOURCE_SHA256 = createHash('sha256').update(SOURCE).digest('hex')

let prisma: PrismaClient | undefined
let ownerId = ''
let foreignId = ''
let projectId = ''
let artifactId = ''
let observationId = ''
let derivedRoot = ''
let ownerCookie = ''
let foreignCookie = ''
let server: ChildProcess | null = null
let baseUrl = ''
let originalAuthSecret: string | undefined
let originalAccessEnforce: string | undefined
let originalDerivedPath: string | undefined

beforeAll(async () => {
  originalAuthSecret = process.env.AUTH_SECRET
  originalAccessEnforce = process.env.ACCESS_ENFORCE
  originalDerivedPath = process.env.REAMON_DERIVED_PATH
  if (!HAS_DB) return
  process.env.AUTH_SECRET = AUTH_SECRET
  process.env.ACCESS_ENFORCE = '0'

  prisma = new PrismaClient()
  const owner = await prisma.user.create({
    data: { email: `${SUFFIX}@example.invalid`, name: 'decompiled source owner' },
  })
  ownerId = owner.id
  const foreign = await prisma.user.create({
    data: { email: `${SUFFIX}-foreign@example.invalid`, name: 'decompiled source foreign user' },
  })
  foreignId = foreign.id
  const project = await prisma.project.create({
    data: { name: 'decompiled source HTTP integration', userId: ownerId },
  })
  projectId = project.id
  const artifact = await prisma.artifact.create({
    data: {
      projectId,
      name: 'Main.java',
      originalName: 'Main.java',
      relativePath: 'Main.java',
      storagePath: `synthetic/${SUFFIX}/Main.java`,
      sha256: SOURCE_SHA256,
      sizeBytes: Buffer.byteLength(SOURCE),
      extension: 'java',
      status: 'READY',
    },
  })
  artifactId = artifact.id
  const relativePath = RELATIVE_PATH(projectId, artifactId)
  const observation = await prisma.reamonObservation.create({
    data: {
      projectId,
      artifactId,
      kind: 'code',
      type: 'code_unit',
      stableKey: `${SUFFIX}:main`,
      canonicalKey: `${SUFFIX}:main`,
      source: 'synthetic-http-acceptance',
      attributes: { codeArtifactId: relativePath, codeArtifactSha256: SOURCE_SHA256 },
    },
  })
  observationId = observation.id

  derivedRoot = await mkdtemp(join(tmpdir(), `${SUFFIX}-`))
  const sourcePath = join(derivedRoot, ...relativePath.split('/'))
  await mkdir(join(sourcePath, '..'), { recursive: true })
  await writeFile(sourcePath, SOURCE)

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
      REAMON_DERIVED_PATH: derivedRoot,
      REAMON_NEXT_TEST_DIST_DIR: `.next-decompiled-source-${port}`,
    },
  })

  const url = `${baseUrl}/api/projects/${projectId}/artifacts/${artifactId}/decompiled/${relativePath}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js decompiled-source test process exited before readiness (${server.exitCode}).`)
    try {
      if ((await fetch(url)).status === 401) return
    } catch { /* the server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stopServer(server)
  server = null
  throw new Error('Next.js decompiled-source test process did not become ready within 60 seconds.')
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
      if (artifactId) expect(await prisma.artifact.count({ where: { id: artifactId } })).toBe(0)
      if (observationId) expect(await prisma.reamonObservation.count({ where: { id: observationId } })).toBe(0)
    } finally {
      await prisma.$disconnect()
    }
  }
  if (derivedRoot) await rm(derivedRoot, { recursive: true, force: true })
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = originalAuthSecret
  if (originalAccessEnforce === undefined) delete process.env.ACCESS_ENFORCE
  else process.env.ACCESS_ENFORCE = originalAccessEnforce
  if (originalDerivedPath === undefined) delete process.env.REAMON_DERIVED_PATH
  else process.env.REAMON_DERIVED_PATH = originalDerivedPath
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

describe.skipIf(!HAS_DB)('decompiled-source HTTP ownership', () => {
  test('owner can read linked source while anonymous and foreign users are denied under ACCESS_ENFORCE=0', async () => {
    const relativePath = RELATIVE_PATH(projectId, artifactId)
    const url = `${baseUrl}/api/projects/${projectId}/artifacts/${artifactId}/decompiled/${relativePath}`

    expect((await fetch(url)).status).toBe(401)
    const foreign = await fetch(url, { headers: { cookie: foreignCookie } })
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual({ error: 'Not found' })

    const owner = await fetch(url, { headers: { cookie: ownerCookie } })
    expect(owner.status).toBe(200)
    expect(owner.headers.get('x-content-sha256')).toBe(SOURCE_SHA256)
    expect(await owner.text()).toBe(SOURCE)
    expect(await readFile(join(derivedRoot, ...relativePath.split('/')), 'utf8')).toBe(SOURCE)
  }, 60_000)
})

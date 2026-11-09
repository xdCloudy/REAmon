/** @vitest-environment node */
/** PostgreSQL-backed HTTP acceptance for server-import artifact ownership. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'

import { AUTH_COOKIE_NAME, createToken } from '@/lib/auth'
import { resolveArtifactStoragePath } from '@/lib/reamon/artifact-storage'

const HAS_DB = process.env.DATABASE_URL !== undefined
const SUFFIX = `server-import-artifact-http-${Date.now()}`
const AUTH_SECRET = 'server-import-artifact-http-secret'
const RELATIVE_PATH = 'bin/payload.bin'
const PAYLOAD = Buffer.from('synthetic server-mounted import artifact')

let prisma: PrismaClient | undefined
let ownerId = ''
let foreignId = ''
let projectId = ''
let importId = ''
let rootsRoot = ''
let sourceRoot = ''
let artifactsRoot = ''
let ownerCookie = ''
let foreignCookie = ''
let server: ChildProcess | null = null
let baseUrl = ''
let originalAuthSecret: string | undefined
let originalAccessEnforce: string | undefined
let originalArtifactsPath: string | undefined
let originalServerSourceRoots: string | undefined

beforeAll(async () => {
  originalAuthSecret = process.env.AUTH_SECRET
  originalAccessEnforce = process.env.ACCESS_ENFORCE
  originalArtifactsPath = process.env.REAMON_ARTIFACTS_PATH
  originalServerSourceRoots = process.env.REAMON_SERVER_SOURCE_ROOTS
  if (!HAS_DB) return
  process.env.AUTH_SECRET = AUTH_SECRET
  process.env.ACCESS_ENFORCE = '0'

  prisma = new PrismaClient()
  const owner = await prisma.user.create({ data: { email: `${SUFFIX}@example.invalid`, name: 'server import owner' } })
  ownerId = owner.id
  const foreign = await prisma.user.create({ data: { email: `${SUFFIX}-foreign@example.invalid`, name: 'server import foreign user' } })
  foreignId = foreign.id
  const project = await prisma.project.create({ data: { name: 'server import artifact HTTP integration', userId: ownerId } })
  projectId = project.id
  rootsRoot = await mkdtemp(join(tmpdir(), `${SUFFIX}-sources-`))
  sourceRoot = join(rootsRoot, 'source')
  artifactsRoot = await mkdtemp(join(tmpdir(), `${SUFFIX}-artifacts-`))
  await mkdir(dirname(join(sourceRoot, RELATIVE_PATH)), { recursive: true })
  await writeFile(join(sourceRoot, RELATIVE_PATH), PAYLOAD)
  process.env.REAMON_ARTIFACTS_PATH = artifactsRoot
  process.env.REAMON_SERVER_SOURCE_ROOTS = rootsRoot

  const workspaceImport = await prisma.workspaceImport.create({
    data: {
      projectId,
      rootName: `synthetic-${SUFFIX}`,
      sourceType: 'SERVER_DIRECTORY',
      status: 'PENDING',
      totalFiles: 1,
      totalBytes: BigInt(PAYLOAD.byteLength),
      manifest: [{ relativePath: RELATIVE_PATH, size: PAYLOAD.byteLength, lastModified: null }],
      metadata: { serverSourcePath: sourceRoot },
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
      REAMON_ARTIFACTS_PATH: artifactsRoot,
      REAMON_SERVER_SOURCE_ROOTS: rootsRoot,
      REAMON_NEXT_TEST_DIST_DIR: `.next-server-import-artifact-${port}`,
    },
  })

  const url = artifactUrl()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js server-import-artifact test process exited before readiness (${server.exitCode}).`)
    try {
      if ((await fetch(url, { method: 'POST' })).status === 401) return
    } catch { /* server is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stopServer(server)
  server = null
  throw new Error('Next.js server-import-artifact test process did not become ready within 60 seconds.')
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
  if (rootsRoot) await rm(rootsRoot, { recursive: true, force: true })
  if (artifactsRoot) await rm(artifactsRoot, { recursive: true, force: true })
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = originalAuthSecret
  if (originalAccessEnforce === undefined) delete process.env.ACCESS_ENFORCE
  else process.env.ACCESS_ENFORCE = originalAccessEnforce
  if (originalArtifactsPath === undefined) delete process.env.REAMON_ARTIFACTS_PATH
  else process.env.REAMON_ARTIFACTS_PATH = originalArtifactsPath
  if (originalServerSourceRoots === undefined) delete process.env.REAMON_SERVER_SOURCE_ROOTS
  else process.env.REAMON_SERVER_SOURCE_ROOTS = originalServerSourceRoots
})

function artifactUrl() {
  return `${baseUrl}/api/projects/${projectId}/imports/${importId}/artifacts?relativePath=${encodeURIComponent(RELATIVE_PATH)}`
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

describe.skipIf(!HAS_DB)('server-import artifact HTTP ownership', () => {
  test('foreign users cannot read or persist server-mounted bytes under ACCESS_ENFORCE=0', async () => {
    const url = artifactUrl()
    expect((await fetch(url, { method: 'POST' })).status).toBe(401)

    const foreign = await fetch(url, { method: 'POST', headers: { cookie: foreignCookie } })
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual({ error: 'Not found' })
    expect(await prisma!.artifact.count({ where: { projectId, importId } })).toBe(0)
    expect(await prisma!.workspaceImport.findUnique({ where: { id: importId }, select: { status: true, uploadedBytes: true } }))
      .toMatchObject({ status: 'PENDING', uploadedBytes: 0n })
    await expect(readFile(join(sourceRoot, RELATIVE_PATH))).resolves.toEqual(PAYLOAD)

    const owner = await fetch(url, { method: 'POST', headers: { cookie: ownerCookie } })
    const result = await owner.json()
    expect(owner.status, JSON.stringify(result)).toBe(201)
    expect(result.artifact).toMatchObject({ relativePath: RELATIVE_PATH, sizeBytes: PAYLOAD.byteLength })
    const stored = await prisma!.artifact.findFirst({
      where: { id: result.artifact.id, projectId, importId },
      select: { projectId: true, importId: true, relativePath: true, sizeBytes: true, sha256: true, storagePath: true },
    })
    expect(stored).toMatchObject({ projectId, importId, relativePath: RELATIVE_PATH, sizeBytes: BigInt(PAYLOAD.byteLength) })
    expect(result.artifact.sha256).toBe(stored!.sha256)
    await expect(readFile(resolveArtifactStoragePath(stored!.storagePath))).resolves.toEqual(PAYLOAD)
  }, 60_000)
})

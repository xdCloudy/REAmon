/** @vitest-environment node */
/**
 * PostgreSQL-backed HTTP acceptance for staged artifact chunk ownership.
 * Uses synthetic records and skips when DATABASE_URL is unavailable.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'

import { AUTH_COOKIE_NAME, createToken } from '@/lib/auth'
import { stagedArtifactPath } from '@/lib/reamon/artifact-import-commit'

const HAS_DB = process.env.DATABASE_URL !== undefined
const SUFFIX = `artifact-chunk-http-${Date.now()}`
const AUTH_SECRET = 'artifact-chunk-http-integration-secret'
const RELATIVE_PATH = 'src/Main.java'
const PAYLOAD = Buffer.from('synthetic staged artifact')

let prisma: PrismaClient | undefined
let ownerId = ''
let foreignId = ''
let projectId = ''
let importId = ''
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
    data: { email: `${SUFFIX}@example.invalid`, name: 'artifact chunk owner' },
  })
  ownerId = owner.id
  const foreign = await prisma.user.create({
    data: { email: `${SUFFIX}-foreign@example.invalid`, name: 'artifact chunk foreign user' },
  })
  foreignId = foreign.id
  const project = await prisma.project.create({
    data: { name: 'artifact chunk HTTP integration', userId: ownerId },
  })
  projectId = project.id
  const workspaceImport = await prisma.workspaceImport.create({
    data: {
      projectId,
      rootName: `synthetic-${SUFFIX}`,
      sourceType: 'BROWSER_DIRECTORY',
      status: 'PENDING',
      totalFiles: 1,
      totalBytes: BigInt(PAYLOAD.byteLength),
      manifest: [{ relativePath: RELATIVE_PATH, size: PAYLOAD.byteLength, lastModified: null }],
    },
  })
  importId = workspaceImport.id

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
      REAMON_NEXT_TEST_DIST_DIR: `.next-artifact-chunks-${port}`,
    },
  })

  const url = `${baseUrl}/api/projects/${projectId}/imports/${importId}/artifacts/chunks?relativePath=${encodeURIComponent(RELATIVE_PATH)}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js artifact-chunk test process exited before readiness (${server.exitCode}).`)
    try {
      if ((await fetch(url, { method: 'PUT' })).status === 401) return
    } catch { /* the server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stopServer(server)
  server = null
  throw new Error('Next.js artifact-chunk test process did not become ready within 60 seconds.')
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
      if (importId) expect(await prisma.workspaceImport.count({ where: { id: importId } })).toBe(0)
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

describe.skipIf(!HAS_DB)('staged artifact chunk HTTP ownership', () => {
  test('owner can upload a chunk while anonymous and foreign users are denied under ACCESS_ENFORCE=0', async () => {
    const url = `${baseUrl}/api/projects/${projectId}/imports/${importId}/artifacts/chunks?relativePath=${encodeURIComponent(RELATIVE_PATH)}`
    const request = {
      method: 'PUT',
      headers: {
        'x-reamon-upload-offset': '0',
        'x-reamon-upload-size': String(PAYLOAD.byteLength),
      },
      body: PAYLOAD,
    }

    expect((await fetch(url, request)).status).toBe(401)
    const foreign = await fetch(url, { ...request, headers: { ...request.headers, cookie: foreignCookie } })
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual({ error: 'Not found' })
    expect(await prisma!.workspaceImport.findUnique({ where: { id: importId }, select: { uploadedBytes: true } }))
      .toMatchObject({ uploadedBytes: 0n })

    const chunkPath = stagedArtifactPath(projectId, importId, RELATIVE_PATH)
    await expect(readFile(chunkPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const owner = await fetch(url, { ...request, headers: { ...request.headers, cookie: ownerCookie } })
    expect(owner.status).toBe(200)
    expect(await owner.json()).toEqual({ receivedBytes: PAYLOAD.byteLength })
    expect(await readFile(chunkPath)).toEqual(PAYLOAD)
    expect(await prisma!.workspaceImport.findUnique({ where: { id: importId }, select: { uploadedBytes: true } }))
      .toMatchObject({ uploadedBytes: BigInt(PAYLOAD.byteLength) })
  }, 60_000)
})

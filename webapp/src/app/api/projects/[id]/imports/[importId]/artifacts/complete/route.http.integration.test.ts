/** @vitest-environment node */
/** PostgreSQL-backed HTTP acceptance for staged artifact completion ownership. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'

import { AUTH_COOKIE_NAME, createToken } from '@/lib/auth'
import { resolveArtifactStoragePath } from '@/lib/reamon/artifact-storage'
import { stagedArtifactPath } from '@/lib/reamon/artifact-import-commit'

const HAS_DB = process.env.DATABASE_URL !== undefined
const SUFFIX = `artifact-complete-http-${Date.now()}`
const AUTH_SECRET = 'artifact-complete-http-integration-secret'
const RELATIVE_PATH = 'src/Main.java'
const PAYLOAD = Buffer.from('synthetic completed artifact')

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
    data: { email: `${SUFFIX}@example.invalid`, name: 'artifact completion owner' },
  })
  ownerId = owner.id
  const foreign = await prisma.user.create({
    data: { email: `${SUFFIX}-foreign@example.invalid`, name: 'artifact completion foreign user' },
  })
  foreignId = foreign.id
  const project = await prisma.project.create({ data: { name: 'artifact completion HTTP integration', userId: ownerId } })
  projectId = project.id
  const workspaceImport = await prisma.workspaceImport.create({
    data: {
      projectId,
      rootName: `synthetic-${SUFFIX}`,
      sourceType: 'BROWSER_DIRECTORY',
      status: 'UPLOADING',
      totalFiles: 1,
      totalBytes: BigInt(PAYLOAD.byteLength),
      uploadedBytes: BigInt(PAYLOAD.byteLength),
      manifest: [{ relativePath: RELATIVE_PATH, size: PAYLOAD.byteLength, lastModified: null }],
    },
  })
  importId = workspaceImport.id

  artifactsRoot = await mkdtemp(join(tmpdir(), `${SUFFIX}-`))
  process.env.REAMON_ARTIFACTS_PATH = artifactsRoot
  const stagePath = stagedArtifactPath(projectId, importId, RELATIVE_PATH)
  await mkdir(dirname(stagePath), { recursive: true })
  await writeFile(stagePath, PAYLOAD)
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
      REAMON_NEXT_TEST_DIST_DIR: `.next-artifact-complete-${port}`,
    },
  })

  const url = `${baseUrl}/api/projects/${projectId}/imports/${importId}/artifacts/complete`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js artifact-complete test process exited before readiness (${server.exitCode}).`)
    try {
      if ((await fetch(url, { method: 'POST' })).status === 401) return
    } catch { /* server is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  await stopServer(server)
  server = null
  throw new Error('Next.js artifact-complete test process did not become ready within 60 seconds.')
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

describe.skipIf(!HAS_DB)('staged artifact completion HTTP ownership', () => {
  test('foreign users cannot promote staged bytes, while the owner persists the exact artifact under ACCESS_ENFORCE=0', async () => {
    const url = `${baseUrl}/api/projects/${projectId}/imports/${importId}/artifacts/complete`
    const body = JSON.stringify({ relativePath: RELATIVE_PATH, mimeType: 'text/x-java' })
    const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body }

    expect((await fetch(url, request)).status).toBe(401)
    const foreign = await fetch(url, { ...request, headers: { ...request.headers, cookie: foreignCookie } })
    expect(foreign.status).toBe(404)
    expect(await foreign.json()).toEqual({ error: 'Not found' })
    expect(await prisma!.artifact.count({ where: { projectId, importId } })).toBe(0)
    const stagePath = stagedArtifactPath(projectId, importId, RELATIVE_PATH)
    await expect(readFile(stagePath)).resolves.toEqual(PAYLOAD)

    const owner = await fetch(url, { ...request, headers: { ...request.headers, cookie: ownerCookie } })
    expect(owner.status).toBe(201)
    const result = await owner.json()
    expect(result.artifact).toMatchObject({ relativePath: RELATIVE_PATH, sizeBytes: PAYLOAD.byteLength })

    const stored = await prisma!.artifact.findFirst({
      where: { id: result.artifact.id, projectId, importId },
      select: { projectId: true, importId: true, relativePath: true, sizeBytes: true, sha256: true, storagePath: true },
    })
    expect(stored).toMatchObject({
      projectId,
      importId,
      relativePath: RELATIVE_PATH,
      sizeBytes: BigInt(PAYLOAD.byteLength),
    })
    expect(result.artifact.sha256).toBe(stored!.sha256)
    await expect(readFile(resolveArtifactStoragePath(stored!.storagePath))).resolves.toEqual(PAYLOAD)
    await expect(readFile(stagePath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)
})

/** @vitest-environment node */
/**
 * PostgreSQL-backed HTTP acceptance for project report ownership and file
 * operations. Uses synthetic records and skips when DATABASE_URL is unavailable.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'

import { AUTH_COOKIE_NAME, createToken } from '@/lib/auth'

const HAS_DB = process.env.DATABASE_URL !== undefined
const SUFFIX = `project-reports-http-${Date.now()}`
const AUTH_SECRET = 'project-reports-http-integration-secret'

let prisma: PrismaClient | undefined
let ownerId = ''
let foreignId = ''
let projectId = ''
let reportId = ''
let reportPath = ''
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
    data: { email: `${SUFFIX}@example.invalid`, name: 'project report owner' },
  })
  ownerId = owner.id
  const foreign = await prisma.user.create({
    data: { email: `${SUFFIX}-foreign@example.invalid`, name: 'project report foreign user' },
  })
  foreignId = foreign.id
  const project = await prisma.project.create({
    data: { name: 'project reports HTTP integration', userId: ownerId, targetDomain: 'project-reports.example.invalid' },
  })
  projectId = project.id
  reportPath = join(tmpdir(), `${SUFFIX}.html`)
  writeFileSync(reportPath, '<!doctype html><html><body>synthetic owner report</body></html>')
  const report = await prisma.report.create({
    data: {
      projectId,
      title: 'Synthetic project report',
      filename: `${SUFFIX}.html`,
      filePath: reportPath,
      fileSize: 65,
      format: 'html',
      metrics: { synthetic: true },
      hasNarratives: false,
    },
  })
  reportId = report.id

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
      REAMON_NEXT_TEST_DIST_DIR: `.next-project-reports-${port}`,
    },
  })

  const url = `${baseUrl}/api/projects/${projectId}/reports`
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
  throw new Error('Next.js project reports test process did not become ready within 60 seconds.')
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
      if (reportId) expect(await prisma.report.count({ where: { id: reportId } })).toBe(0)
    } finally {
      await prisma.$disconnect()
    }
  }
  if (reportPath && existsSync(reportPath)) unlinkSync(reportPath)
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

describe.skipIf(!HAS_DB)('project reports HTTP ownership', () => {
  test('owner can list, download, and delete reports while anonymous and foreign users are blocked', async () => {
    const base = `${baseUrl}/api/projects/${projectId}/reports`
    const item = `${base}/${reportId}`
    const generate = { method: 'POST' }

    expect((await fetch(base)).status).toBe(401)
    expect((await fetch(base, generate)).status).toBe(401)
    expect((await fetch(item)).status).toBe(401)
    expect((await fetch(item, { method: 'DELETE' })).status).toBe(401)

    const foreignCookieHeader = { cookie: foreignCookie }
    expect((await fetch(base, { headers: foreignCookieHeader })).status).toBe(404)
    expect((await fetch(base, { ...generate, headers: foreignCookieHeader })).status).toBe(404)
    expect((await fetch(item, { headers: foreignCookieHeader })).status).toBe(404)
    expect((await fetch(item, { method: 'DELETE', headers: foreignCookieHeader })).status).toBe(404)
    expect(await prisma!.report.count({ where: { id: reportId } })).toBe(1)
    expect(existsSync(reportPath)).toBe(true)

    const ownerReports = await fetch(base, { headers: { cookie: ownerCookie } })
    expect(ownerReports.status).toBe(200)
    expect(await ownerReports.json()).toMatchObject([{ id: reportId, title: 'Synthetic project report' }])

    const ownerDownload = await fetch(item, { headers: { cookie: ownerCookie } })
    expect(ownerDownload.status).toBe(200)
    expect(ownerDownload.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(await ownerDownload.text()).toContain('synthetic owner report')

    const ownerDelete = await fetch(item, { method: 'DELETE', headers: { cookie: ownerCookie } })
    expect(ownerDelete.status).toBe(204)
    expect(await prisma!.report.count({ where: { id: reportId } })).toBe(0)
    expect(existsSync(reportPath)).toBe(false)
  }, 60_000)
})

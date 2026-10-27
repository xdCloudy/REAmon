/** @vitest-environment node */
/**
 * Opt-in PostgreSQL acceptance for import reservations. Set `DATABASE_URL`,
 * `REAMON_ARTIFACTS_PATH`, and `REAMON_IMPORT_CAPACITY_INTEGRATION=1`; capacity
 * rejection uses a size-limited test mount and never writes artifact bytes.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import prisma from '@/lib/prisma'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  artifactCapacity: vi.fn(),
  realArtifactCapacity: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

vi.mock('@/lib/reamon/artifact-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reamon/artifact-storage')>()
  mocks.realArtifactCapacity.mockImplementation(actual.getArtifactVolumeCapacity)
  return { ...actual, getArtifactVolumeCapacity: mocks.artifactCapacity }
})

import { POST } from './route'
import { artifactRoot } from '@/lib/reamon/artifact-storage'
import { PUT as PUTChunk } from './[importId]/artifacts/chunks/route'
import { removeStagedImport } from '@/lib/reamon/artifact-storage'
import { stagedArtifactPath } from '@/lib/reamon/artifact-import-commit'

const enabled = process.env.REAMON_IMPORT_CAPACITY_INTEGRATION === '1'
  && Boolean(process.env.DATABASE_URL)
  && Boolean(process.env.REAMON_ARTIFACTS_PATH)
let projectId = ''
let projectOwnerId = ''
let rootName = ''

function requestFor(name: string, size = 60): Request {
  return new Request(`http://localhost/api/projects/${projectId}/imports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rootName: name,
      files: [{ relativePath: 'probe.bin', size }],
    }),
  })
}

function chunkRequest(importId: string, size: number): Request {
  return new Request(`http://localhost/api/projects/${projectId}/imports/${importId}/artifacts/chunks?relativePath=probe.bin`, {
    method: 'PUT',
    headers: {
      'Content-Length': String(size),
      'X-REAmon-Upload-Offset': '0',
      'X-REAmon-Upload-Size': String(size),
    },
    body: new Uint8Array(size),
  })
}

function params() {
  return { params: Promise.resolve({ id: projectId }) }
}

function chunkParams(importId: string) {
  return { params: Promise.resolve({ id: projectId, importId }) }
}

describe.skipIf(!enabled)('POST workspace import capacity admission against PostgreSQL', () => {
  beforeAll(async () => {
    await mkdir(artifactRoot(), { recursive: true })
    const user = await prisma.user.findFirst({ select: { id: true } })
    if (!user) throw new Error('Capacity integration requires an existing database user')
    projectOwnerId = user.id
    rootName = `CapacityProbe-${randomUUID()}`
    const project = await prisma.project.create({
      data: { userId: user.id, name: rootName, projectKind: 'REVERSE_ENGINEERING' },
      select: { id: true },
    })
    projectId = project.id
    mocks.requireEffectiveUser.mockResolvedValue({ userId: user.id })
    mocks.requireProjectAccess.mockResolvedValue({ project: { id: project.id, userId: user.id } })
  })

  afterAll(async () => {
    if (projectId) {
      await prisma.workspaceActivity.deleteMany({
        where: { projectId, message: { contains: rootName } },
      })
      await prisma.workspaceImport.deleteMany({ where: { projectId } })
      await prisma.target.deleteMany({ where: { projectId } })
      await prisma.project.deleteMany({ where: { id: projectId, userId: projectOwnerId } })
    }
    await prisma.$disconnect()
  })

  test('serializes simultaneous imports and counts the first pending reservation', async () => {
    const existing = await prisma.workspaceImport.findMany({
      where: { status: { notIn: ['COMPLETED', 'CANCELLED', 'CANCELLING', 'FINALIZING'] } },
      select: { totalBytes: true, uploadedBytes: true },
    })
    const alreadyReserved = existing.reduce((sum, item) => {
      const remaining = item.totalBytes - item.uploadedBytes
      return sum + (remaining > 0n ? remaining : 0n)
    }, 0n)
    const simulatedFreeBytes = alreadyReserved + 100n
    let capacityCalls = 0
    let releaseFirstCapacityCheck!: () => void
    let firstCapacityReached!: () => void
    const holdFirstCapacityCheck = new Promise<void>((resolve) => { releaseFirstCapacityCheck = resolve })
    const firstCapacityCheckReached = new Promise<void>((resolve) => { firstCapacityReached = resolve })
    mocks.artifactCapacity.mockImplementation(async () => {
      capacityCalls += 1
      if (capacityCalls === 1) {
        firstCapacityReached()
        await holdFirstCapacityCheck
      }
      return {
        available: true,
        totalBytes: simulatedFreeBytes.toString(),
        usedBytes: '0',
        freeBytes: simulatedFreeBytes.toString(),
        usedPercent: 0,
        checkedAt: new Date().toISOString(),
      }
    })

    try {
      const firstRequest = POST(requestFor(rootName), params())
      await firstCapacityCheckReached
      const secondRequest = POST(requestFor(`${rootName}-second`), params())
      // Give the competing request time to block on the transaction advisory lock.
      await new Promise((resolve) => setTimeout(resolve, 100))
      releaseFirstCapacityCheck()

      const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest])
      const first = await firstResponse.json()
      const second = await secondResponse.json()

      expect(firstResponse.status).toBe(201)
      expect(secondResponse.status).toBe(507)
      expect(second).toMatchObject({ availableBytes: simulatedFreeBytes.toString(), requiredBytes: (alreadyReserved + 120n).toString() })
      expect(capacityCalls).toBe(2)
    } finally {
      releaseFirstCapacityCheck()
    }
  })

  test('rejects a manifest request one byte above actual filesystem capacity', async () => {
    mocks.artifactCapacity.mockImplementation(mocks.realArtifactCapacity)
    const storage = await mocks.realArtifactCapacity()
    if (!storage.available || storage.freeBytes === null) {
      throw new Error('The artifact test volume must report filesystem capacity')
    }
    const active = await prisma.workspaceImport.findMany({
      where: { status: { notIn: ['COMPLETED', 'CANCELLED', 'CANCELLING', 'FINALIZING'] } },
      select: { totalBytes: true, uploadedBytes: true },
    })
    const reserved = active.reduce((sum, item) => {
      const remaining = item.totalBytes - item.uploadedBytes
      return sum + (remaining > 0n ? remaining : 0n)
    }, 0n)
    const freeBytes = BigInt(storage.freeBytes)
    const declaredBytes = freeBytes >= reserved ? freeBytes - reserved + 1n : 1n
    if (declaredBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('The filesystem capacity probe exceeds the manifest numeric range')
    }
    const response = await POST(requestFor(`${rootName}-filesystem-full`, Number(declaredBytes)), params())
    const body = await response.json()

    expect(response.status).toBe(507)
    expect(body).toMatchObject({
      availableBytes: freeBytes.toString(),
      requiredBytes: (reserved + declaredBytes).toString(),
    })
    expect(await prisma.workspaceImport.count({ where: { projectId } })).toBe(1)
  })

  test('returns 507 on a real full-volume chunk write and accepts the same offset after space is freed', async () => {
    const size = 2 * 1024 * 1024
    const importRow = await prisma.workspaceImport.create({
      data: {
        projectId,
        rootName: `${rootName}-chunk-pressure`,
        sourceType: 'BROWSER_DIRECTORY',
        totalFiles: 1,
        totalBytes: BigInt(size),
        manifest: [{ relativePath: 'probe.bin', size }],
      },
      select: { id: true },
    })
    const stagedPath = stagedArtifactPath(projectId, importRow.id, 'probe.bin')
    const fillerPath = path.join(artifactRoot(), `CapacityProbe-${randomUUID()}.fill`)
    await mkdir(path.dirname(stagedPath), { recursive: true })
    const volume = await mocks.realArtifactCapacity()
    if (!volume.available || volume.freeBytes === null) throw new Error('The artifact test volume must report filesystem capacity')
    const freeBytes = BigInt(volume.freeBytes)
    const keepFree = 512n * 1024n
    const fillerBytes = freeBytes - keepFree
    if (fillerBytes <= 0n || fillerBytes >= BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('The bounded artifact test volume does not have enough free space for the pressure probe')
    }

    try {
      await writeFile(fillerPath, Buffer.alloc(Number(fillerBytes)))
      const failed = await PUTChunk(chunkRequest(importRow.id, size), chunkParams(importRow.id))
      expect(failed.status).toBe(507)
      expect(await prisma.workspaceImport.findUnique({ where: { id: importRow.id }, select: { uploadedBytes: true } })).toMatchObject({ uploadedBytes: 0n })
      expect((await stat(stagedPath)).size).toBe(0)

      await rm(fillerPath, { force: true })
      const retried = await PUTChunk(chunkRequest(importRow.id, size), chunkParams(importRow.id))
      expect(retried.status).toBe(200)
      expect(await retried.json()).toEqual({ receivedBytes: size })
      expect(await prisma.workspaceImport.findUnique({ where: { id: importRow.id }, select: { uploadedBytes: true } })).toMatchObject({ uploadedBytes: BigInt(size) })
      expect((await stat(stagedPath)).size).toBe(size)
    } finally {
      await rm(fillerPath, { force: true })
      await removeStagedImport(projectId, importRow.id)
    }
  })
})

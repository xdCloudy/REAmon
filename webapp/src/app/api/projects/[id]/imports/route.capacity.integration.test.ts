/** @vitest-environment node */
/**
 * Opt-in PostgreSQL acceptance for import reservations. Set `DATABASE_URL` and
 * `REAMON_IMPORT_CAPACITY_INTEGRATION=1`; this test simulates capacity and never
 * writes artifact bytes.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import prisma from '@/lib/prisma'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  artifactCapacity: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

vi.mock('@/lib/reamon/artifact-storage', () => ({
  artifactRoot: () => '/tmp/reamon-import-capacity-integration',
  getArtifactVolumeCapacity: mocks.artifactCapacity,
}))

import { POST } from './route'

const enabled = process.env.REAMON_IMPORT_CAPACITY_INTEGRATION === '1'
  && Boolean(process.env.DATABASE_URL)
let projectId = ''
let projectOwnerId = ''
let rootName = ''

function requestFor(name: string): Request {
  return new Request(`http://localhost/api/projects/${projectId}/imports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rootName: name,
      files: [{ relativePath: 'probe.bin', size: 60 }],
    }),
  })
}

function params() {
  return { params: Promise.resolve({ id: projectId }) }
}

describe.skipIf(!enabled)('POST workspace import capacity admission against PostgreSQL', () => {
  beforeAll(async () => {
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
})

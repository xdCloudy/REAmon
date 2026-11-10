/** @vitest-environment node */
/** Opt-in PostgreSQL acceptance for durable and revision-guarded function scan checkpoints. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import prisma from '@/lib/prisma'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  getActiveWorkspaceImportSelection: vi.fn(),
}))

vi.mock('@/lib/access', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/access')>(),
  requireEffectiveUser: mocks.requireEffectiveUser,
}))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: mocks.getActiveWorkspaceImportSelection }))

import { GET, PUT } from './route'

const enabled = process.env.REAMON_FUNCTION_QUEUE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL)
const initialState = {
  version: 1,
  cursor: null,
  complete: false,
  backlog: [],
  pendingUnits: [],
  segmentAfterCursor: null,
  segmentComplete: false,
  segmentActive: false,
}
let projectId = ''
let projectOwnerId = ''
let foreignUserId = ''
let taskId = ''
let artifactId = ''

function params() { return { params: Promise.resolve({ id: projectId }) } }
function stateRequest(state: unknown, expectedRevision: number) {
  return new Request(`http://localhost/api/projects/${projectId}/visualizer/deobfuscate/scan-state?taskId=${taskId}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state, expectedRevision }),
  })
}
function readRequest() {
  return new Request(`http://localhost/api/projects/${projectId}/visualizer/deobfuscate/scan-state?taskId=${taskId}`)
}

describe.skipIf(!enabled)('Function queue scan state against PostgreSQL', () => {
  beforeAll(async () => {
    const user = await prisma.user.findFirst({ select: { id: true } })
    if (!user) throw new Error('Function queue integration requires an existing database user')
    projectOwnerId = user.id
    const foreign = await prisma.user.create({
      data: { email: `function-queue-foreign-${randomUUID()}@example.invalid`, name: 'Function queue foreign user' },
      select: { id: true },
    })
    foreignUserId = foreign.id
    const project = await prisma.project.create({
      data: { userId: user.id, name: `FunctionQueueState-${randomUUID()}`, projectKind: 'REVERSE_ENGINEERING' },
      select: { id: true },
    })
    projectId = project.id
    const artifact = await prisma.artifact.create({
      data: {
        projectId, name: 'scan-state.bin', originalName: 'scan-state.bin', storagePath: 'integration-fixture',
        sha256: 'a'.repeat(64), sizeBytes: BigInt(1), extension: '.bin',
      },
      select: { id: true },
    })
    artifactId = artifact.id
    const task = await prisma.task.create({
      data: { projectId, artifactId, capability: 'decompile', title: 'Function queue checkpoint acceptance', status: 'COMPLETED' },
      select: { id: true },
    })
    taskId = task.id

    mocks.requireEffectiveUser.mockResolvedValue({ userId: user.id })
    mocks.getActiveWorkspaceImportSelection.mockResolvedValue({ artifactWhere: { id: artifactId } })
  })

  afterAll(async () => {
    try {
      vi.unstubAllEnvs()
      if (projectId) {
        await prisma.reamonFunctionQueueState.deleteMany({ where: { projectId } })
        await prisma.task.deleteMany({ where: { projectId } })
        await prisma.artifact.deleteMany({ where: { projectId } })
        await prisma.project.deleteMany({ where: { id: projectId, userId: projectOwnerId } })
        expect(await prisma.project.count({ where: { id: projectId } })).toBe(0)
      }
      if (foreignUserId) {
        await prisma.user.deleteMany({ where: { id: foreignUserId } })
        expect(await prisma.user.count({ where: { id: foreignUserId } })).toBe(0)
      }
    } finally {
      await prisma.$disconnect()
    }
  })

  it('round-trips checkpoints and atomically rejects stale browser writes', async () => {
    const empty = await GET(readRequest(), params())
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ state: null, revision: 0 })

    const first = await PUT(stateRequest(initialState, 0), params())
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ revision: 1 })

    const loaded = await GET(readRequest(), params())
    expect(loaded.status).toBe(200)
    expect(await loaded.json()).toEqual({ state: initialState, revision: 1 })

    const advancedState = { ...initialState, cursor: 'code-unit-2', segmentActive: true }
    const advanced = await PUT(stateRequest(advancedState, 1), params())
    expect(advanced.status).toBe(200)
    expect(await advanced.json()).toEqual({ revision: 2 })

    const stale = await PUT(stateRequest(initialState, 1), params())
    expect(stale.status).toBe(409)
    expect((await stale.json()).error).toMatch(/changed in another browser/i)
    const afterStale = await GET(readRequest(), params())
    expect(await afterStale.json()).toEqual({ state: advancedState, revision: 2 })

    const competingWrites = await Promise.all([
      PUT(stateRequest({ ...advancedState, cursor: 'browser-a' }, 2), params()),
      PUT(stateRequest({ ...advancedState, cursor: 'browser-b' }, 2), params()),
    ])
    expect(competingWrites.map((response) => response.status).sort()).toEqual([200, 409])
    const afterRace = await GET(readRequest(), params())
    const finalCheckpoint = await afterRace.json()
    expect(finalCheckpoint.revision).toBe(3)
    expect(['browser-a', 'browser-b']).toContain(finalCheckpoint.state.cursor)
    expect(await prisma.reamonFunctionQueueState.count({ where: { projectId, taskId, artifactId } })).toBe(1)
  })

  it('rejects malformed or oversized checkpoint state without writing it', async () => {
    const malformed = await PUT(stateRequest({ ...initialState, cursor: 7 }, 3), params())
    expect(malformed.status).toBe(400)
    const row = await prisma.reamonFunctionQueueState.findUnique({ where: { taskId }, select: { revision: true } })
    expect(row?.revision).toBe(3)
  })

  it('denies foreign checkpoint reads and writes with ACCESS_ENFORCE=0', async () => {
    vi.stubEnv('ACCESS_ENFORCE', '0')
    mocks.requireEffectiveUser.mockResolvedValue({ userId: foreignUserId })

    const foreignRead = await GET(readRequest(), params())
    expect(foreignRead.status).toBe(404)
    expect(await foreignRead.json()).toEqual({ error: 'Not found' })

    const foreignWrite = await PUT(stateRequest({ ...initialState, cursor: 'foreign-write' }, 3), params())
    expect(foreignWrite.status).toBe(404)
    expect(await foreignWrite.json()).toEqual({ error: 'Not found' })

    const saved = await prisma.reamonFunctionQueueState.findUnique({ where: { taskId }, select: { projectId: true, revision: true, state: true } })
    expect(saved).toMatchObject({ projectId, revision: 3 })
    expect(['browser-a', 'browser-b']).toContain((saved?.state as typeof initialState).cursor)
    vi.unstubAllEnvs()
  })
})

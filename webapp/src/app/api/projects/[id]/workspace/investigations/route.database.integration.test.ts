/** @vitest-environment node */
/** Opt-in PostgreSQL acceptance for project investigation paging and attempt summaries. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import prisma from '@/lib/prisma'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

import { GET } from './route'

const enabled = process.env.REAMON_INVESTIGATION_QUEUE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL)
let projectId = ''
let projectOwnerId = ''
let taskIds: string[] = []
let artifactId = ''
let caseIds: string[] = []

function params() { return { params: Promise.resolve({ id: projectId }) } }
function request(cursor?: string) {
  const query = new URLSearchParams({ limit: '1' })
  if (cursor) query.set('cursor', cursor)
  return new Request(`http://localhost/api/projects/${projectId}/workspace/investigations?${query}`)
}

describe.skipIf(!enabled)('Project investigation queue against PostgreSQL', () => {
  beforeAll(async () => {
    const user = await prisma.user.findFirst({ select: { id: true } })
    if (!user) throw new Error('Investigation queue integration requires an existing database user')
    projectOwnerId = user.id
    const project = await prisma.project.create({
      data: { userId: user.id, name: `InvestigationQueue-${randomUUID()}`, projectKind: 'REVERSE_ENGINEERING' },
      select: { id: true },
    })
    projectId = project.id
    const artifact = await prisma.artifact.create({
      data: {
        projectId, name: 'failed-input.dex', originalName: 'failed-input.dex', storagePath: 'integration-fixture',
        sha256: 'a'.repeat(64), sizeBytes: BigInt(1), extension: '.dex',
      },
      select: { id: true },
    })
    artifactId = artifact.id

    for (let index = 0; index < 2; index += 1) {
      const task = await prisma.task.create({
        data: { projectId, artifactId, capability: 'decompile', title: `Failed decompile ${index + 1}`, status: 'FAILED' },
        select: { id: true },
      })
      taskIds.push(task.id)
      const investigation = await prisma.reamonInvestigationCase.create({
        data: {
          projectId, taskId: task.id, artifactId, artifactSha256: 'a'.repeat(64), capability: 'decompile',
          providerId: 'fixture-provider', providerVersion: '1.0', status: 'QUEUED',
          failureEvidence: { providerText: 'private failure payload must not be returned by the queue' },
          history: [], requestedBy: user.id, revision: 1,
          createdAt: new Date(index === 0 ? '2026-10-29T00:00:01.000Z' : '2026-10-29T00:00:02.000Z'),
        },
        select: { id: true },
      })
      caseIds.push(investigation.id)
    }

    await prisma.reamonCodeAttempt.create({
      data: {
        projectId, ownerUserId: user.id, artifactId, runKey: taskIds[0],
        codeUnitId: `investigation:${caseIds[0]}:unit:ground-truth-1`, unitName: 'decode_header',
        language: 'C', sourceHash: 'b'.repeat(64), providerName: 'fixture', modelIdentifier: 'test-model',
        scope: 'manual-investigation', status: 'SUCCEEDED', resultSource: 'int decode_header(void) { return 1; }',
        validationStatus: 'UNAVAILABLE', timeoutMs: 10_000, createdAt: new Date('2026-10-29T00:00:03.000Z'),
      },
    })
    await prisma.reamonCodeAttempt.create({
      data: {
        projectId, ownerUserId: user.id, artifactId, runKey: taskIds[1],
        codeUnitId: `investigation:${caseIds[1]}:unit:ground-truth-2`, unitName: 'decode_entry',
        language: 'C', sourceHash: 'c'.repeat(64), providerName: 'fixture', modelIdentifier: 'test-model',
        scope: 'manual-investigation', status: 'RUNNING', timeoutMs: 10_000, createdAt: new Date('2026-10-29T00:00:04.000Z'),
      },
    })
    await prisma.reamonCodeAttempt.create({
      data: {
        projectId, ownerUserId: user.id, artifactId, runKey: taskIds[1],
        codeUnitId: `investigation:${caseIds[1]}:unit:ground-truth-3`, unitName: 'decode_footer',
        language: 'C', sourceHash: 'd'.repeat(64), providerName: 'fixture', modelIdentifier: 'test-model',
        scope: 'manual-investigation', status: 'SUCCEEDED',
        resultSource: 'int decode_footer(void) { return 3; }', validationStatus: 'UNAVAILABLE', timeoutMs: 10_000,
        createdAt: new Date('2026-10-29T00:00:05.000Z'),
      },
    })

    mocks.requireEffectiveUser.mockResolvedValue({ userId: user.id })
    mocks.requireProjectAccess.mockResolvedValue({ project: { id: projectId, userId: user.id } })
  })

  afterAll(async () => {
    if (projectId) await prisma.project.deleteMany({ where: { id: projectId, userId: projectOwnerId } })
    await prisma.$disconnect()
  })

  it('pages through persisted cases and reports only bounded, source-free attempt summaries', async () => {
    const first = await GET(request(), params())
    expect(first.status).toBe(200)
    const firstPage = await first.json()
    expect(firstPage.investigations).toHaveLength(1)
    expect(firstPage.investigations[0]).toMatchObject({
      id: caseIds[1], taskId: taskIds[1], status: 'RUNNING', attemptCount: 2, active: true, hasCandidate: true,
      attempts: [
        { unitName: 'decode_footer', status: 'SUCCEEDED', candidateAvailable: true },
        { unitName: 'decode_entry', status: 'RUNNING', candidateAvailable: false },
      ],
    })
    expect(firstPage.nextCursor).toBe(caseIds[1])
    expect(JSON.stringify(firstPage)).not.toContain('private failure payload')
    expect(JSON.stringify(firstPage)).not.toContain('int decode_header')

    const second = await GET(request(firstPage.nextCursor), params())
    expect(second.status).toBe(200)
    const secondPage = await second.json()
    expect(secondPage.investigations).toHaveLength(1)
    expect(secondPage.investigations[0]).toMatchObject({
      id: caseIds[0], taskId: taskIds[0], status: 'SUCCEEDED', attemptCount: 1, active: false, hasCandidate: true,
      attempts: [{ unitName: 'decode_header', status: 'SUCCEEDED', candidateAvailable: true }],
    })
    expect(secondPage.investigations[0].attempts[0]).not.toHaveProperty('resultSource')
    expect(secondPage.nextCursor).toBeNull()
  })
})

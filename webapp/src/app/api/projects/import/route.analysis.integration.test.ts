/** @vitest-environment node */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import JSZip from 'jszip'
import prisma from '@/lib/prisma'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  clearProjectGraph: vi.fn(),
  restoreGraph: vi.fn(),
  orchestratorFetch: vi.fn(),
}))

vi.mock('@/lib/access', () => ({ requireEffectiveUser: mocks.requireEffectiveUser }))
vi.mock('@/lib/graphRestore', () => ({
  clearProjectGraph: mocks.clearProjectGraph,
  restoreGraph: mocks.restoreGraph,
}))
vi.mock('@/lib/orchestrator', () => ({ orchestratorFetch: mocks.orchestratorFetch }))

import { POST } from './route'

const enabled = process.env.REAMON_PROJECT_ARCHIVE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL)
const projectName = `ArchiveRoundTripProbe-${randomUUID()}`
let ownerId = ''
let importedProjectId = ''

async function archiveFile(): Promise<File> {
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify({ version: '1.0.0', projectName, targetDomain: '', stats: {} }))
  zip.file('project.json', JSON.stringify({ id: 'source-project', userId: 'untrusted-owner', name: projectName, targetDomain: '' }))
  zip.file('analysis/tasks.json', JSON.stringify([{
    id: 'source-task', targetId: 'source-target', artifactId: 'source-artifact',
    providerPluginId: 'reamon-ghidra', capability: 'decompile', title: 'Decompile binary',
    category: 'analysis', status: 'COMPLETED', progress: 100,
    startedAt: '2026-10-01T11:00:00.000Z', completedAt: '2026-10-01T11:02:00.000Z',
    createdAt: '2026-10-01T10:59:00.000Z', updatedAt: '2026-10-01T11:02:00.000Z',
    options: { apiKey: 'must-not-be-imported' }, result: { recoveredSource: 'payload' }, runToken: 'stale-token',
  }]))
  zip.file('analysis/observations.json', JSON.stringify([{
    id: 'source-observation', projectId: 'source-project', taskId: 'source-task',
    targetId: 'source-target', artifactId: 'source-artifact', kind: 'entity', type: 'function',
    stableKey: 'source-artifact:source-run:function:1000', canonicalKey: 'function:1000',
    label: 'FUN_1000', source: 'reamon-ghidra', relation: null, fromKey: null, toKey: null,
    fromCanonicalKey: null, toCanonicalKey: null, attributes: { address: '1000' },
    isPending: false, createdAt: '2026-10-01T11:02:00.000Z', updatedAt: '2026-10-01T11:02:00.000Z',
  }]))
  return new File([new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))], 'project.zip', {
    type: 'application/zip',
  })
}

describe.skipIf(!enabled)('project archive task/observation restore against PostgreSQL', () => {
  beforeAll(async () => {
    const user = await prisma.user.findFirst({ select: { id: true } })
    if (!user) throw new Error('Archive integration requires an existing database user')
    ownerId = user.id
    mocks.requireEffectiveUser.mockResolvedValue({ userId: user.id })
  })

  afterAll(async () => {
    if (ownerId && projectName) {
      await prisma.project.deleteMany({ where: { userId: ownerId, name: projectName } })
    }
    await prisma.$disconnect()
  })

  test('remaps observations to inert task records and preserves unavailable source links', async () => {
    const form = new FormData()
    form.set('file', await archiveFile())
    const response = await POST(new NextRequest('http://localhost/api/projects/import', { method: 'POST', body: form }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    importedProjectId = body.projectId

    const [task, observation] = await Promise.all([
      prisma.task.findFirst({ where: { projectId: importedProjectId }, orderBy: { createdAt: 'desc' } }),
      prisma.reamonObservation.findFirst({ where: { projectId: importedProjectId } }),
    ])
    expect(task).toBeTruthy()
    expect(task).toMatchObject({ status: 'IMPORTED', projectId: importedProjectId, targetId: null, artifactId: null, providerId: null, runToken: null })
    expect(task!.id).not.toBe('source-task')
    expect(task!.options).toMatchObject({ importOrigin: { taskId: 'source-task', providerPluginId: 'reamon-ghidra' } })
    expect(task!.options).not.toHaveProperty('apiKey')
    expect(task!.result).toBeNull()
    expect(observation).toMatchObject({
      projectId: importedProjectId,
      taskId: task!.id,
      targetId: null,
      artifactId: null,
      attributes: { importOrigin: { observationId: 'source-observation', taskId: 'source-task', targetId: 'source-target', artifactId: 'source-artifact' } },
    })
  })
})

/** @vitest-environment node */
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ analyze: vi.fn() }))

vi.mock('./provider-registry', () => ({
  getBuiltinProvider: () => ({
    manifest: {
      id: 'reamon-dex-decompiler',
      name: 'Rust DEX-to-Java Decompiler',
      category: 'decompilation',
      integration: 'native',
      acceptsTargetTypes: ['FILE'],
      acceptsFormats: ['apk'],
      capabilities: ['decompile'],
      produces: ['CodeUnit'],
      requirements: [],
    },
    analyze: mocks.analyze,
  }),
}))

vi.mock('./capabilities', () => ({
  resolveCapabilities: () => [{ capabilities: ['decompile'] }],
}))

import prisma from '@/lib/prisma'
import { listWorkspaceCodeUnits } from '@/lib/mcp/workspaceCodeTools'
import { executeAnalysisTask } from './task-executor'
import type { ToolObservation } from './types'

const enabled = process.env.REAMON_RUN_DB_INTEGRATION === '1'
const describeDatabase = describe.skipIf(!enabled)

describeDatabase('DEX streamed task persistence with PostgreSQL', () => {
  const suffix = randomUUID()
  const artifactRoot = path.join(os.tmpdir(), `reamon-dex-db-${suffix}`)
  const userId = `dex-db-user-${suffix}`
  const projectId = `dex-db-project-${suffix}`
  const providerId = `dex-db-provider-${suffix}`
  const artifactId = `dex-db-artifact-${suffix}`
  const taskId = `dex-db-task-${suffix}`
  const storagePath = `${projectId}/${artifactId}/input.apk`

  beforeAll(async () => {
    process.env.REAMON_ARTIFACTS_PATH = artifactRoot
    await mkdir(path.dirname(path.join(artifactRoot, storagePath)), { recursive: true })
    await writeFile(path.join(artifactRoot, storagePath), Buffer.from('disposable APK fixture'))
    await prisma.user.create({ data: { id: userId, name: 'DEX database test', email: `${suffix}@example.invalid` } })
    await prisma.project.create({ data: { id: projectId, userId, name: 'DEX database integration' } })
    await prisma.reamonProvider.create({
      data: {
        id: providerId,
        pluginId: 'reamon-dex-decompiler',
        name: 'Rust DEX-to-Java Decompiler',
        category: 'decompilation',
        integration: 'native',
        acceptsTargetTypes: ['FILE'],
        acceptsFormats: ['apk'],
        capabilities: ['decompile'],
        produces: ['CodeUnit'],
        requirements: [],
      },
    })
    await prisma.artifact.create({
      data: {
        id: artifactId,
        projectId,
        name: 'input.apk',
        originalName: 'input.apk',
        relativePath: 'input.apk',
        storagePath,
        sha256: 'a'.repeat(64),
        sizeBytes: BigInt(Buffer.byteLength('disposable APK fixture')),
        extension: 'apk',
        profile: { targetType: 'FILE', format: 'apk' },
      },
    })
    await prisma.task.create({
      data: {
        id: taskId,
        projectId,
        artifactId,
        providerId,
        capability: 'decompile',
        title: 'Persist streamed DEX functions',
        options: { requiresApproval: false },
      },
    })
  })

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { id: projectId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.reamonProvider.deleteMany({ where: { id: providerId } })
    await rm(artifactRoot, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  test('promotes the complete run batch and exposes it through MCP code lookup', async () => {
    const methods: ToolObservation[] = [
      {
        kind: 'entity',
        type: 'function',
        key: 'dex:method:1',
        label: 'Main#start',
        attributes: { identity: 'input.apk:0:1:LMain;->start()V', name: 'start', unitType: 'function' },
      },
      {
        kind: 'entity',
        type: 'function',
        key: 'dex:method:2',
        label: 'Main#resume',
        attributes: { identity: 'input.apk:0:2:LMain;->resume()V', name: 'resume', unitType: 'function' },
      },
    ]
    mocks.analyze.mockImplementation(async (input: {
      persistObservationBatch?: (observations: ToolObservation[]) => Promise<number>
    }) => {
      if (!input.persistObservationBatch) throw new Error('Task executor omitted the streamed-observation callback')
      const streamedFunctionObservationCount = await input.persistObservationBatch(methods)
      return {
        status: 'completed',
        toolId: 'reamon-dex-decompiler',
        capabilities: ['decompile'],
        produced: ['CodeUnit'],
        data: {
          observations: [],
          discoveredMethodCount: methods.length,
          returnedMethodCount: methods.length,
          streamedFunctionObservationCount,
        },
      }
    })

    const result = await executeAnalysisTask(projectId, taskId, 'db-integration-test')

    expect(result?.outcome).toBe('COMPLETED')
    const rows = await prisma.reamonObservation.findMany({
      where: { projectId, taskId, source: 'reamon-dex-decompiler', type: 'function' },
      orderBy: { stableKey: 'asc' },
      select: { stableKey: true, isPending: true, attributes: true },
    })
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => !row.isPending && !('analysisPending' in (row.attributes as Record<string, unknown>)))).toBe(true)
    expect(await prisma.reamonObservation.count({ where: { projectId, taskId, source: { startsWith: 'reamon-dex-decompiler:pending:' } } })).toBe(0)

    const listed = await listWorkspaceCodeUnits({
      token: { tokenId: `db-test-${suffix}`, userId, tokenPrefix: 'db-test', name: 'DB test', scopes: ['recon:read'] },
    }, { projectId, taskId, limit: 10 })
    expect(listed.total).toBe(2)
    expect(listed.units.map((unit) => unit.name)).toEqual([
      'start',
      'resume',
    ])
  })
})

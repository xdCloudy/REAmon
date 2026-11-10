/** @vitest-environment node */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import prisma from '@/lib/prisma'
import { ingestToolResult } from './result-ingestion'
import { executeDexDecompiler } from './dex-decompiler'
import type { ToolExecutionInput, ToolObservation } from './types'

const enabled = process.env.REAMON_RUN_DB_INTEGRATION === '1'
  && Boolean(process.env.DATABASE_URL)
  && Boolean(process.env.REAMON_DEX_DECOMPILER_URL)
  && Boolean(process.env.REAMON_DEX_FIXTURE_PATH)
  && Boolean(process.env.REAMON_ARTIFACTS_PATH && process.env.REAMON_DERIVED_PATH)
const describeDatabase = describe.skipIf(!enabled)

describeDatabase('pinned DEX analyzer CFG through PostgreSQL observation persistence', () => {
  const suffix = randomUUID()
  const userId = `dex-db-user-${suffix}`
  const projectId = `dex-db-project-${suffix}`
  const providerId = `dex-db-provider-${suffix}`
  const artifactId = `dex-db-artifact-${suffix}`
  const taskId = `dex-db-task-${suffix}`
  const artifactsRoot = path.resolve(process.env.REAMON_ARTIFACTS_PATH || '/tmp/reamon-artifacts')
  const derivedRoot = path.resolve(process.env.REAMON_DERIVED_PATH || '/tmp/reamon-derived')
  const fixturePath = path.resolve(process.env.REAMON_DEX_FIXTURE_PATH || '')
  const storagePath = path.relative(artifactsRoot, fixturePath).split(path.sep).join('/')
  const profile = {
    targetType: 'FILE' as const,
    format: 'dex',
    mimeType: 'application/vnd.android.dex',
    extension: 'dex',
    architecture: null,
    platform: 'Android',
    runtimes: ['Dalvik'],
    embeddedArtifacts: [],
    entropy: null,
    metadata: { containerFormat: 'dex' },
  }
  let userCreated = false
  let projectCreated = false
  let providerCreated = false
  let artifactCreated = false

  beforeAll(async () => {
    if (!fixturePath.startsWith(`${artifactsRoot}${path.sep}`)) {
      throw new Error('Synthetic DEX fixture must live inside REAMON_ARTIFACTS_PATH')
    }
    const fixture = await readFile(fixturePath)
    const fixtureStat = await stat(fixturePath)
    const fixtureSha256 = createHash('sha256').update(fixture).digest('hex')

    await prisma.user.create({ data: { id: userId, name: 'Synthetic DEX CFG DB test', email: `${suffix}@example.invalid` } })
    userCreated = true
    await prisma.project.create({ data: { id: projectId, userId, name: 'Synthetic DEX CFG persistence' } })
    projectCreated = true
    await prisma.reamonProvider.create({
      data: {
        id: providerId,
        pluginId: 'reamon-dex-decompiler',
        name: 'Androguard DEX Decompiler',
        category: 'static_analysis',
        integration: 'process',
        acceptsTargetTypes: ['FILE'],
        acceptsFormats: ['dex', 'apk'],
        capabilities: ['decompile'],
        produces: ['CodeUnit', 'DecompiledSource', 'Function', 'ControlFlowGraph'],
        requirements: [],
      },
    })
    providerCreated = true
    await prisma.artifact.create({
      data: {
        id: artifactId,
        projectId,
        name: 'synthetic-dex-cfg-fixture',
        originalName: path.basename(fixturePath),
        relativePath: 'synthetic.dex',
        storagePath,
        sha256: fixtureSha256,
        sizeBytes: BigInt(fixtureStat.size),
        extension: 'dex',
        mimeType: profile.mimeType,
        profile,
      },
    })
    artifactCreated = true
    await prisma.task.create({
      data: {
        id: taskId,
        projectId,
        artifactId,
        providerId,
        capability: 'decompile',
        title: 'Persist synthetic DEX CFG evidence',
        status: 'COMPLETED',
        options: { requiresApproval: false },
      },
    })
  }, 30_000)

  test('persists and reads back the analyzer CFG with its graph records intact', async () => {
    const input: ToolExecutionInput = {
      targetProfile: profile,
      projectId,
      artifactId,
      taskId,
      runToken: `run-${suffix}`,
      artifactPath: fixturePath,
      artifactRelativePath: 'synthetic.dex',
    }
    const result = await executeDexDecompiler(input)
    if (result.status !== 'completed') throw new Error(result.error || 'DEX decompiler execution failed')
    const data = result.data as { observations: ToolObservation[]; returnedMethodCount: number }
    expect(data.returnedMethodCount).toBeGreaterThan(0)

    const expectedFunction = data.observations.find((observation) => observation.type === 'function')
    if (!expectedFunction || typeof expectedFunction.attributes.controlFlowGraph !== 'string') {
      throw new Error('DEX provider did not emit a serialized CFG observation')
    }
    expect(expectedFunction.attributes.decompilationEngineVersion).toBe('d458efd15d74351e83f4e8968c75ef17c71f3c65')
    const expectedGraph = JSON.parse(expectedFunction.attributes.controlFlowGraph) as {
      entryBlock: number
      exitBlock: number
      blockCount: number
      edgeCount: number
      blocks: unknown[]
      edges: unknown[]
    }

    await prisma.$transaction((tx) => ingestToolResult(tx, {
      projectId,
      taskId,
      targetId: null,
      artifactId,
      source: result.toolId,
      data,
      maxObservations: 1_000,
    }))

    const persistedFunctions = await prisma.reamonObservation.findMany({
      where: { projectId, artifactId, taskId, source: result.toolId, type: 'function' },
      select: { attributes: true },
    })
    expect(persistedFunctions).toHaveLength(data.returnedMethodCount)
    const persistedGraphText = (persistedFunctions[0]?.attributes as Record<string, unknown> | undefined)?.controlFlowGraph
    expect(typeof persistedGraphText).toBe('string')
    const persistedGraph = JSON.parse(persistedGraphText as string)
    expect(persistedGraph).toEqual(expectedGraph)
    expect(persistedGraph.blockCount).toBe(persistedGraph.blocks.length)
    expect(persistedGraph.edgeCount).toBe(persistedGraph.edges.length)
  }, 5 * 60_000)

  afterAll(async () => {
    try {
      if (projectCreated) await prisma.project.deleteMany({ where: { id: projectId } })
      if (artifactCreated) await prisma.artifact.deleteMany({ where: { id: artifactId } })
      if (providerCreated) await prisma.reamonProvider.deleteMany({ where: { id: providerId } })
      if (userCreated) await prisma.user.deleteMany({ where: { id: userId } })
      if (projectCreated) await rm(path.join(derivedRoot, projectId), { recursive: true, force: true })
    } finally {
      await prisma.$disconnect()
    }
  }, 30_000)
})

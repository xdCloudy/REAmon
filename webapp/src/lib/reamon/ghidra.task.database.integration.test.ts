/** @vitest-environment node */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import prisma from '@/lib/prisma'
import { ingestToolResult } from './result-ingestion'
import { executeGhidra } from './ghidra'
import type { ToolExecutionInput, ToolObservation } from './types'

const enabled = process.env.REAMON_RUN_DB_INTEGRATION === '1'
  && Boolean(process.env.DATABASE_URL)
  && Boolean(process.env.REAMON_GHIDRA_URL)
  && Boolean(process.env.REAMON_GHIDRA_FIXTURE_PATH)
  && Boolean(process.env.REAMON_ARTIFACTS_PATH && process.env.REAMON_DERIVED_PATH)
const describeDatabase = describe.skipIf(!enabled)

describeDatabase('pinned Ghidra CFG through PostgreSQL observation persistence', () => {
  const suffix = randomUUID()
  const userId = `ghidra-db-user-${suffix}`
  const projectId = `ghidra-db-project-${suffix}`
  const providerId = `ghidra-db-provider-${suffix}`
  const artifactId = `ghidra-db-artifact-${suffix}`
  const taskId = `ghidra-db-task-${suffix}`
  const artifactsRoot = path.resolve(process.env.REAMON_ARTIFACTS_PATH || '/tmp/reamon-artifacts')
  const derivedRoot = path.resolve(process.env.REAMON_DERIVED_PATH || '/tmp/reamon-derived')
  const fixturePath = path.resolve(process.env.REAMON_GHIDRA_FIXTURE_PATH || '')
  const storagePath = path.relative(artifactsRoot, fixturePath).split(path.sep).join('/')
  const profile = {
    targetType: 'FILE' as const,
    format: 'elf',
    mimeType: 'application/x-elf',
    extension: 'elf',
    architecture: 'x86_64',
    platform: 'Linux',
    runtimes: ['Go'],
    embeddedArtifacts: [],
    entropy: null,
    metadata: { containerFormat: 'elf' },
  }
  let userCreated = false
  let projectCreated = false
  let providerCreated = false
  let artifactCreated = false

  beforeAll(async () => {
    if (!fixturePath.startsWith(`${artifactsRoot}${path.sep}`)) {
      throw new Error('Synthetic ELF fixture must live inside REAMON_ARTIFACTS_PATH')
    }
    const fixture = await readFile(fixturePath)
    const fixtureStat = await stat(fixturePath)
    const fixtureSha256 = createHash('sha256').update(fixture).digest('hex')

    await prisma.user.create({ data: { id: userId, name: 'Synthetic Ghidra CFG DB test', email: `${suffix}@example.invalid` } })
    userCreated = true
    await prisma.project.create({ data: { id: projectId, userId, name: 'Synthetic Ghidra CFG persistence' } })
    projectCreated = true
    await prisma.reamonProvider.create({
      data: {
        id: providerId,
        pluginId: 'reamon-ghidra',
        name: 'Ghidra Native Decompiler',
        category: 'static_analysis',
        integration: 'process',
        acceptsTargetTypes: ['FILE'],
        acceptsFormats: ['elf', 'pe', 'mach-o'],
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
        name: 'synthetic-ghidra-cfg-fixture',
        originalName: path.basename(fixturePath),
        relativePath: 'synthetic.elf',
        storagePath,
        sha256: fixtureSha256,
        sizeBytes: BigInt(fixtureStat.size),
        extension: 'elf',
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
        title: 'Persist synthetic Ghidra CFG evidence',
        status: 'COMPLETED',
        options: { requiresApproval: false },
      },
    })
  }, 30_000)

  test('persists and reads back analyzer CFG metrics and graph records intact', async () => {
    const input: ToolExecutionInput = {
      targetProfile: profile,
      projectId,
      artifactId,
      taskId,
      runToken: `run-${suffix}`,
      artifactPath: fixturePath,
      artifactRelativePath: 'synthetic.elf',
    }
    const result = await executeGhidra(input)
    if (result.status !== 'completed') throw new Error(result.error || 'Ghidra execution failed')
    const data = result.data as { observations: ToolObservation[] }
    const expectedUnits = data.observations.filter((observation) => observation.type === 'code_unit')
    const expectedGraphs = expectedUnits.flatMap((observation) => {
      const graph = observation.attributes.controlFlowGraph
      const metrics = observation.attributes.controlFlowMetrics
      return typeof graph === 'string' && typeof metrics === 'string' ? [{ graph, metrics }] : []
    })
    expect(expectedGraphs.length).toBeGreaterThan(0)

    await prisma.$transaction((tx) => ingestToolResult(tx, {
      projectId,
      taskId,
      targetId: null,
      artifactId,
      source: result.toolId,
      data,
      maxObservations: 10_000,
    }))

    const persistedUnits = await prisma.reamonObservation.findMany({
      where: { projectId, artifactId, taskId, source: result.toolId, type: 'code_unit' },
      select: { attributes: true },
    })
    expect(persistedUnits).toHaveLength(expectedUnits.length)
    const persistedGraphs = persistedUnits.flatMap((observation) => {
      const attributes = observation.attributes as Record<string, unknown>
      return typeof attributes.controlFlowGraph === 'string' && typeof attributes.controlFlowMetrics === 'string'
        ? [{ graph: attributes.controlFlowGraph, metrics: attributes.controlFlowMetrics }]
        : []
    })
    expect(persistedGraphs).toHaveLength(expectedGraphs.length)
    expect(persistedGraphs.sort((a, b) => a.graph.localeCompare(b.graph))).toEqual(
      expectedGraphs.sort((a, b) => a.graph.localeCompare(b.graph)),
    )
  }, 20 * 60_000)

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

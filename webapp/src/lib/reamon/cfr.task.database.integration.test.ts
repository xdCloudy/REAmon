/** @vitest-environment node */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import prisma from '@/lib/prisma'
import { ingestToolResult } from './result-ingestion'
import { executeCfr } from './cfr'
import type { TargetProfile, ToolExecutionInput, ToolObservation } from './types'

const enabled = process.env.REAMON_RUN_DB_INTEGRATION === '1'
  && Boolean(process.env.REAMON_CFR_URL)
  && Boolean(process.env.REAMON_JVM_CFR_FIXTURE_PATH)
  && Boolean(process.env.REAMON_ARTIFACTS_PATH && process.env.REAMON_DERIVED_PATH)
const describeDatabase = describe.skipIf(!enabled)

describeDatabase('CFR JVM fixture through PostgreSQL observation persistence', () => {
  const suffix = randomUUID()
  const userId = `cfr-db-user-${suffix}`
  const projectId = `cfr-db-project-${suffix}`
  const providerId = `cfr-db-provider-${suffix}`
  const artifactId = `cfr-db-artifact-${suffix}`
  const taskId = `cfr-db-task-${suffix}`
  const artifactsRoot = path.resolve(process.env.REAMON_ARTIFACTS_PATH || '/tmp/reamon-artifacts')
  const derivedRoot = path.resolve(process.env.REAMON_DERIVED_PATH || '/tmp/reamon-derived')
  const fixturePath = path.resolve(process.env.REAMON_JVM_CFR_FIXTURE_PATH || '')
  const storagePath = path.relative(artifactsRoot, fixturePath).split(path.sep).join('/')
  const profile: TargetProfile = {
    targetType: 'FILE',
    format: 'jar',
    mimeType: 'application/java-archive',
    extension: 'jar',
    architecture: null,
    platform: 'jvm',
    runtimes: ['java'],
    embeddedArtifacts: [],
    entropy: null,
    metadata: {},
  }
  let artifactCreated = false
  let projectCreated = false
  let providerCreated = false
  let userCreated = false
  let fixtureSha256 = ''
  let sourceFileCount = 0
  let observationCount = 0
  let allStoredSourcesHashVerified = false
  let storedSourceHashes: Record<string, string> = {}
  const evidencePath = process.env.REAMON_BENCHMARK_EVIDENCE_PATH?.trim()

  beforeAll(async () => {
    if (!fixturePath.startsWith(`${artifactsRoot}${path.sep}`)) {
      throw new Error('JVM CFR fixture must live inside REAMON_ARTIFACTS_PATH')
    }
    const fixture = await readFile(fixturePath)
    const fixtureStat = await stat(fixturePath)
    fixtureSha256 = createHash('sha256').update(fixture).digest('hex')

    await prisma.user.create({ data: { id: userId, name: 'CFR JVM DB test', email: `${suffix}@example.invalid` } })
    userCreated = true
    await prisma.project.create({ data: { id: projectId, userId, name: 'CFR JVM PostgreSQL persistence' } })
    projectCreated = true
    await prisma.reamonProvider.create({
      data: {
        id: providerId,
        pluginId: 'reamon-cfr',
        name: 'CFR Java Decompiler',
        category: 'static_analysis',
        integration: 'process',
        acceptsTargetTypes: ['FILE'],
        acceptsFormats: ['jar', 'class'],
        capabilities: ['decompile'],
        produces: ['CodeUnit', 'DecompiledSource'],
        requirements: [],
      },
    })
    providerCreated = true
    await prisma.artifact.create({
      data: {
        id: artifactId,
        projectId,
        name: 'jvm-cfr-fixture',
        originalName: 'fixture.jar',
        relativePath: 'fixture.jar',
        storagePath,
        sha256: fixtureSha256,
        sizeBytes: BigInt(fixtureStat.size),
        extension: 'jar',
        mimeType: 'application/java-archive',
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
        title: 'Persist CFR JVM fixture output',
        status: 'COMPLETED',
        options: { requiresApproval: false },
      },
    })
  }, 30_000)

  test('runs the CFR adapter, persists returned code units, and verifies stored source hashes', async () => {
    const input: ToolExecutionInput = {
      targetProfile: profile,
      projectId,
      artifactId,
      taskId,
      runToken: `run-${suffix}`,
      artifactPath: fixturePath,
      artifactRelativePath: 'fixture.jar',
    }
    const result = await executeCfr(input)
    if (result.status !== 'completed') throw new Error(result.error || 'CFR execution failed')
    const data = result.data as {
      observations: ToolObservation[]
      decompiledCodeUnitCount: number
      truncated: boolean
      cfrVersion: string
    }
    expect(data).toMatchObject({ truncated: false, cfrVersion: '0.152' })
    expect(data.observations).toHaveLength(data.decompiledCodeUnitCount)
    expect(data.decompiledCodeUnitCount).toBe(2)
    sourceFileCount = data.decompiledCodeUnitCount

    await prisma.$transaction((tx) => ingestToolResult(tx, {
      projectId,
      taskId,
      targetId: null,
      artifactId,
      source: result.toolId,
      data,
      maxObservations: 20_000,
    }))

    const rows = await prisma.reamonObservation.findMany({
      where: { projectId, artifactId, taskId, source: 'reamon-cfr', type: 'code_unit' },
      select: { stableKey: true, attributes: true },
      take: 20_001,
    })
    expect(rows).toHaveLength(sourceFileCount)
    observationCount = rows.length
    const expectedPaths = new Set([
      'org/reamon/fixture/Main.java',
      'org/reamon/fixture/RuleEngine.java',
    ])
    expect(new Set(rows.map((row) => (row.attributes as Record<string, unknown>).relativePath))).toEqual(expectedPaths)

    storedSourceHashes = {}
    for (const row of rows) {
      const attributes = row.attributes as Record<string, unknown>
      expect(attributes.inputArtifactSha256).toBe(fixtureSha256)
      expect(attributes.language).toBe('Java')
      expect(attributes.decompilationEngineVersion).toBe('0.152')
      expect(typeof attributes.codeArtifactId).toBe('string')
      expect(attributes.decompiledSourceSha256).toMatch(/^[a-f0-9]{64}$/)
      const artifactIdValue = attributes.codeArtifactId as string
      const sourcePath = path.resolve(derivedRoot, ...artifactIdValue.replaceAll('\\', '/').split('/'))
      expect(sourcePath.startsWith(`${derivedRoot}${path.sep}`)).toBe(true)
      const source = await readFile(sourcePath)
      expect(createHash('sha256').update(source).digest('hex')).toBe(attributes.decompiledSourceSha256)
      storedSourceHashes[attributes.relativePath as string] = attributes.decompiledSourceSha256 as string
    }
    allStoredSourcesHashVerified = true
  }, 25 * 60_000)

  afterAll(async () => {
    try {
      if (evidencePath && allStoredSourcesHashVerified) {
        await mkdir(path.dirname(path.resolve(evidencePath)), { recursive: true })
        await writeFile(path.resolve(evidencePath), `${JSON.stringify({
          schemaVersion: 1,
          fixtureId: process.env.REAMON_BENCHMARK_FIXTURE_ID || 'jvm-multimodule-cfr-linux-amd64',
          artifactSha256: fixtureSha256,
          provider: 'CFR 0.152',
          projectId,
          taskId,
          sourceFileCount,
          persistedCodeUnitCount: observationCount,
          storedSourceHashes,
          allStoredSourcesHashVerified,
          metrics: {
            recovered_source_files: { state: 'MEASURED', denominator: 2, value: sourceFileCount },
            source_inventory_complete: { state: 'MEASURED', denominator: 1, value: Number(sourceFileCount === 2) },
            exact_bytecode_classes: { state: 'UNAVAILABLE', denominator: 2 },
            runtime_oracle: { state: 'UNAVAILABLE', denominator: 1 },
            sampled_behavior_oracle: { state: 'UNAVAILABLE', denominator: 1 },
          },
        }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      }
    } finally {
      if (projectCreated) await prisma.project.deleteMany({ where: { id: projectId } })
      if (artifactCreated) await prisma.artifact.deleteMany({ where: { id: artifactId } })
      if (providerCreated) await prisma.reamonProvider.deleteMany({ where: { id: providerId } })
      if (userCreated) await prisma.user.deleteMany({ where: { id: userId } })
      await rm(path.join(derivedRoot, projectId), { recursive: true, force: true })
      await prisma.$disconnect()
    }
  }, 30_000)
})

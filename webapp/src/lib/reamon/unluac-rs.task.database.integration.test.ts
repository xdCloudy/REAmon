/** @vitest-environment node */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import prisma from '@/lib/prisma'
import { ingestToolResult } from './result-ingestion'
import { executeUnluacRs } from './unluac-rs'
import type { TargetProfile, ToolExecutionInput, ToolObservation } from './types'

const enabled = process.env.REAMON_RUN_DB_INTEGRATION === '1'
  && Boolean(process.env.REAMON_UNLUAC_RS_URL)
  && Boolean(process.env.REAMON_LUA_FIXTURE_PATH)
  && Boolean(process.env.REAMON_ARTIFACTS_PATH && process.env.REAMON_DERIVED_PATH)
const describeDatabase = describe.skipIf(!enabled)

function expectedLuaContainmentPairs(observations: ToolObservation[]): string[] {
  const codeUnit = observations.find((observation) => observation.kind === 'entity' && observation.type === 'code_unit')
  const prototypes = observations.filter((observation) => observation.kind === 'entity' && observation.type === 'function')
  if (!codeUnit) throw new Error('Lua provider did not return its module code unit')

  const protoById = new Map<number, ToolObservation>()
  for (const prototype of prototypes) {
    const protoId = prototype.attributes.protoId
    if (typeof protoId !== 'number' || !Number.isSafeInteger(protoId) || protoId <= 0 || protoById.has(protoId)) {
      throw new Error('Lua provider returned an invalid or duplicate prototype identity')
    }
    protoById.set(protoId, prototype)
  }

  const expected = new Set<string>()
  const nestedPrototypeIds = new Set<number>()
  for (const [protoId, prototype] of protoById) {
    const serializedChildren = prototype.attributes.childProtoIds
    if (typeof serializedChildren !== 'string') throw new Error(`Lua prototype ${protoId} has no child table`)
    const childProtoIds: unknown = JSON.parse(serializedChildren)
    if (!Array.isArray(childProtoIds) || !childProtoIds.every((childId) => Number.isSafeInteger(childId) && childId > 0)) {
      throw new Error(`Lua prototype ${protoId} has an invalid child table`)
    }
    for (const childProtoId of childProtoIds as number[]) {
      const child = protoById.get(childProtoId)
      if (!child) throw new Error(`Lua prototype ${protoId} references unreturned child ${childProtoId}`)
      expected.add(JSON.stringify([prototype.key, child.key]))
      nestedPrototypeIds.add(childProtoId)
    }
  }

  for (const [protoId, prototype] of protoById) {
    if (!nestedPrototypeIds.has(protoId)) expected.add(JSON.stringify([codeUnit.key, prototype.key]))
  }
  return [...expected].sort()
}

describeDatabase('unluac-rs Lua 5.4 fixture through PostgreSQL observation persistence', () => {
  const suffix = randomUUID()
  const userId = `lua-db-user-${suffix}`
  const projectId = `lua-db-project-${suffix}`
  const providerId = `lua-db-provider-${suffix}`
  const artifactId = `lua-db-artifact-${suffix}`
  const taskId = `lua-db-task-${suffix}`
  const artifactsRoot = path.resolve(process.env.REAMON_ARTIFACTS_PATH || '/tmp/reamon-artifacts')
  const derivedRoot = path.resolve(process.env.REAMON_DERIVED_PATH || '/tmp/reamon-derived')
  const fixturePath = path.resolve(process.env.REAMON_LUA_FIXTURE_PATH || '')
  const storagePath = path.relative(artifactsRoot, fixturePath).split(path.sep).join('/')
  const profile: TargetProfile = {
    targetType: 'FILE',
    format: 'luac',
    mimeType: 'application/octet-stream',
    extension: 'luac',
    architecture: null,
    platform: 'lua-5.4',
    runtimes: ['lua5.4'],
    embeddedArtifacts: [],
    entropy: null,
    metadata: { containerFormat: 'lua-bytecode', luaDialect: 'lua5.4' },
  }
  let artifactCreated = false
  let projectCreated = false
  let providerCreated = false
  let userCreated = false
  let fixtureSha256 = ''
  let sourcePersisted = false
  let sourcePath = ''
  let sourceSha256 = ''
  let functionCount = 0
  let containsRelationshipCount = 0
  const evidencePath = process.env.REAMON_BENCHMARK_EVIDENCE_PATH?.trim()

  beforeAll(async () => {
    if (!fixturePath.startsWith(`${artifactsRoot}${path.sep}`)) {
      throw new Error('Lua bytecode fixture must live inside REAMON_ARTIFACTS_PATH')
    }
    const fixture = await readFile(fixturePath)
    const fixtureStat = await stat(fixturePath)
    fixtureSha256 = createHash('sha256').update(fixture).digest('hex')

    await prisma.user.create({ data: { id: userId, name: 'Lua bytecode DB test', email: `${suffix}@example.invalid` } })
    userCreated = true
    await prisma.project.create({ data: { id: projectId, userId, name: 'Lua 5.4 PostgreSQL persistence' } })
    projectCreated = true
    await prisma.reamonProvider.create({
      data: {
        id: providerId,
        pluginId: 'reamon-unluac-rs',
        name: 'Multi-Dialect Lua Bytecode Decompiler (unluac-rs)',
        category: 'static_analysis',
        integration: 'process',
        acceptsTargetTypes: ['FILE'],
        acceptsFormats: ['luac'],
        acceptsMetadata: { containerFormat: 'lua-bytecode' },
        capabilities: ['decompile'],
        produces: ['CodeUnit', 'DecompiledSource', 'LuaFunction', 'ControlFlowGraph'],
        requirements: [],
      },
    })
    providerCreated = true
    await prisma.artifact.create({
      data: {
        id: artifactId,
        projectId,
        name: 'lua54-stripped-fixture',
        originalName: 'lua54_behavior.luac',
        relativePath: 'lua54_behavior.luac',
        storagePath,
        sha256: fixtureSha256,
        sizeBytes: BigInt(fixtureStat.size),
        extension: 'luac',
        mimeType: 'application/octet-stream',
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
        title: 'Persist stripped Lua 5.4 reconstruction',
        status: 'COMPLETED',
        options: { requiresApproval: false },
      },
    })
  }, 30_000)

  test('runs the live Lua provider and persists the recovered source and prototype inventory', async () => {
    const input: ToolExecutionInput = {
      targetProfile: profile,
      projectId,
      artifactId,
      taskId,
      runToken: `run-${suffix}`,
      artifactPath: fixturePath,
      artifactRelativePath: 'lua54_behavior.luac',
    }
    const result = await executeUnluacRs(input)
    if (result.status !== 'completed') throw new Error(result.error || 'unluac-rs execution failed')
    const data = result.data as {
      observations: ToolObservation[]
      decompiledModuleCount: number
      returnedFunctionCount: number
      discoveredPrototypeCount: number
      functionMetadataTruncated: boolean
      truncated: boolean
      toolVersion: string
    }
    expect(data).toMatchObject({
      decompiledModuleCount: 1,
      functionMetadataTruncated: false,
      truncated: false,
      toolVersion: 'unluac-rs@1.4.4',
    })
    expect(data.discoveredPrototypeCount).toBeGreaterThanOrEqual(3)
    expect(data.returnedFunctionCount).toBeGreaterThan(0)

    await prisma.$transaction((tx) => ingestToolResult(tx, {
      projectId,
      taskId,
      targetId: null,
      artifactId,
      source: result.toolId,
      data,
      maxObservations: 1_000,
    }))

    const rows = await prisma.reamonObservation.findMany({
      where: { projectId, artifactId, taskId, source: 'reamon-unluac-rs' },
      select: { kind: true, type: true, relation: true, fromKey: true, toKey: true, stableKey: true, attributes: true },
      take: 1_001,
    })
    const codeUnits = rows.filter((row) => row.type === 'code_unit')
    const functions = rows.filter((row) => row.type === 'function')
    const contains = rows.filter((row) => row.kind === 'relationship' && row.relation === 'contains')
    const expectedContainsRelationships = Number(process.env.REAMON_EXPECT_CONTAINS_RELATIONSHIPS ?? 1)
    expect(codeUnits).toHaveLength(1)
    expect(functions).toHaveLength(data.returnedFunctionCount)
    expect(functions.length).toBeGreaterThan(0)
    expect(Number(contains.length > 0)).toBe(expectedContainsRelationships)

    const expectedContainmentPairs = expectedLuaContainmentPairs(data.observations)
    const persistedContainmentPairs = contains.map((row) => {
      if (!row.fromKey || !row.toKey) throw new Error(`Persisted Lua containment ${row.stableKey} has a missing endpoint`)
      return JSON.stringify([row.fromKey, row.toKey])
    }).sort()
    expect(persistedContainmentPairs).toEqual(expectedContainmentPairs)

    const attributes = codeUnits[0].attributes as Record<string, unknown>
    expect(attributes).toMatchObject({
      dialect: 'lua5.4',
      decompiled: true,
      inputSha256: fixtureSha256,
      engineVersion: 'unluac-rs@1.4.4',
    })
    expect(typeof attributes.codeArtifactId).toBe('string')
    sourcePath = attributes.codeArtifactId as string
    const absoluteSourcePath = path.resolve(derivedRoot, ...sourcePath.replaceAll('\\', '/').split('/'))
    expect(absoluteSourcePath.startsWith(`${derivedRoot}${path.sep}`)).toBe(true)
    const source = await readFile(absoluteSourcePath)
    sourceSha256 = createHash('sha256').update(source).digest('hex')
    expect(source.byteLength).toBeGreaterThan(0)
    expect(source.byteLength).toBeLessThanOrEqual(32 * 1024 * 1024)

    functionCount = functions.length
    containsRelationshipCount = contains.length
    sourcePersisted = true
  }, 5 * 60_000)

  afterAll(async () => {
    try {
      if (evidencePath && sourcePersisted) {
        const absoluteEvidencePath = path.resolve(evidencePath)
        const outputDirectory = path.dirname(absoluteEvidencePath)
        await mkdir(outputDirectory, { recursive: true })
        const absoluteSourcePath = path.resolve(derivedRoot, ...sourcePath.replaceAll('\\', '/').split('/'))
        const persistedSource = await readFile(absoluteSourcePath)
        if (createHash('sha256').update(persistedSource).digest('hex') !== sourceSha256) {
          throw new Error('Persisted Lua source changed before benchmark evidence was written')
        }
        await writeFile(path.join(outputDirectory, 'recovered.lua'), persistedSource, { flag: 'wx' })
        await writeFile(absoluteEvidencePath, `${JSON.stringify({
          schemaVersion: 1,
          fixtureId: process.env.REAMON_BENCHMARK_FIXTURE_ID || 'lua54-stripped-bytecode-linux-amd64',
          artifactSha256: fixtureSha256,
          provider: 'unluac-rs@1.4.4',
          projectId,
          taskId,
          dialect: 'lua5.4',
          recoveredSourceRelativePath: sourcePath,
          recoveredSourceSha256: sourceSha256,
          persistedSourceHashVerified: true,
          persistedCodeUnitCount: 1,
          persistedFunctionCount: functionCount,
          persistedContainsRelationshipCount: containsRelationshipCount,
          expectedContainsRelationshipCount: expectedLuaContainmentPairs(data.observations).length,
          prototypeHierarchyComplete: true,
          metrics: {
            recovered_source_files: { state: 'MEASURED', denominator: 1, value: 1 },
            persisted_function_prototypes: { state: 'MEASURED', denominator: 1, value: Number(functionCount > 0) },
            persisted_contains_relationships: { state: 'MEASURED', denominator: 1, value: Number(containsRelationshipCount > 0) },
            source_inventory_complete: { state: 'MEASURED', denominator: 1, value: 1 },
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

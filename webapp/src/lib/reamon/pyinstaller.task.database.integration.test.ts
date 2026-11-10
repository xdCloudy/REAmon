/** @vitest-environment node */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import prisma from '@/lib/prisma'
import { ingestToolResult } from './result-ingestion'
import { executePyInstaller } from './pyinstaller'
import {
  createPyInstallerBenchmarkEvidence,
  isPyInstallerStructuredSourceFixture,
  matchesPyInstallerFixtureSource,
  matchesPyInstallerStructuredFixtureSource,
  mutatePyInstallerStructuredFixtureSource,
  PYINSTALLER_MUTATED_SOURCE_CONTROL_FIXTURE_ID,
  PYINSTALLER_STRUCTURED_SOURCE_FIXTURE_ID,
} from './pyinstaller.benchmark-evidence'
import type { TargetProfile, ToolExecutionInput } from './types'

const enabled = process.env.REAMON_RUN_DB_INTEGRATION === '1'
  && Boolean(process.env.REAMON_PYINSTALLER_URL && process.env.REAMON_PYCDC_URL)
  && Boolean(process.env.REAMON_PYINSTALLER_FIXTURE_PATH)
  && Boolean(process.env.REAMON_ARTIFACTS_PATH && process.env.REAMON_DERIVED_PATH)
const describeDatabase = describe.skipIf(!enabled)
const runWorkerIntegration = process.env.REAMON_TASK_WORKER_INTEGRATION === '1'

describeDatabase('PyInstaller continuation with PostgreSQL observation persistence', () => {
  const suffix = randomUUID()
  const userId = `pyi-db-user-${suffix}`
  const projectId = `pyi-db-project-${suffix}`
  const providerId = `pyi-db-provider-${suffix}`
  const artifactId = `pyi-db-artifact-${suffix}`
  const artifactsRoot = path.resolve(process.env.REAMON_ARTIFACTS_PATH || '/tmp/reamon-artifacts')
  const derivedRoot = path.resolve(process.env.REAMON_DERIVED_PATH || '/tmp/reamon-derived')
  const fixturePath = process.env.REAMON_PYINSTALLER_FIXTURE_PATH
    || path.join(artifactsRoot, 'qa/pyinstaller-db-integration/fixture')
  const storagePath = path.relative(artifactsRoot, path.resolve(fixturePath)).split(path.sep).join('/')
  const profile: TargetProfile = {
    targetType: 'FILE',
    format: 'elf',
    mimeType: 'application/x-executable',
    extension: 'elf',
    architecture: null,
    platform: 'linux',
    runtimes: ['python'],
    embeddedArtifacts: [],
    entropy: null,
    metadata: { containerFormat: 'pyinstaller' },
  }
  let artifactCreated = false
  let projectCreated = false
  let providerCreated = false
  let userCreated = false
  let fixtureSha256 = ''
  let directEvidence: {
    extractedModuleCount: number
    knownSourceMatchedCount: number
    reconstructionMatchedCount: number
    structuredMutationRejectedCount?: number
    structuredMutationFalseAcceptanceCount?: number
    originalSourceFalseAcceptanceCount?: number
  } | undefined
  let workerReachedTerminalPage = false
  const benchmarkEvidencePath = process.env.REAMON_BENCHMARK_EVIDENCE_PATH?.trim()

  beforeAll(async () => {
    const absoluteFixture = path.resolve(fixturePath)
    if (!absoluteFixture.startsWith(`${artifactsRoot}${path.sep}`)) {
      throw new Error('PyInstaller DB fixture must live inside REAMON_ARTIFACTS_PATH')
    }
    const fixture = await readFile(absoluteFixture)
    const fixtureStat = await stat(absoluteFixture)
    const sha256 = createHash('sha256').update(fixture).digest('hex')
    fixtureSha256 = sha256

    await prisma.user.create({ data: { id: userId, name: 'PyInstaller DB test', email: `${suffix}@example.invalid` } })
    userCreated = true
    await prisma.project.create({ data: { id: projectId, userId, name: 'PyInstaller PostgreSQL continuation' } })
    projectCreated = true
    await prisma.reamonProvider.create({
      data: {
        id: providerId,
        pluginId: 'reamon-pyinstaller',
        name: 'PyInstaller Python Recovery (pyinstxtractor-go + pycdc)',
        category: 'static_analysis',
        integration: 'process',
        acceptsTargetTypes: ['FILE'],
        acceptsFormats: ['elf', 'pe', 'pe-dll', 'pe-dotnet', 'macho'],
        acceptsMetadata: { containerFormat: 'pyinstaller' },
        capabilities: ['decompile'],
        produces: ['CodeUnit', 'DecompiledSource', 'PythonModule', 'ExtractedBytecode'],
        requirements: [],
      },
    })
    providerCreated = true
    await prisma.artifact.create({
      data: {
        id: artifactId,
        projectId,
        name: 'pyinstaller-fixture',
        originalName: 'pyinstaller-fixture',
        relativePath: 'pyinstaller-fixture',
        storagePath,
        sha256,
        sizeBytes: BigInt(fixtureStat.size),
        extension: 'elf',
        mimeType: 'application/x-executable',
        profile,
      },
    })
    artifactCreated = true
  }, 30_000)

  afterAll(async () => {
    try {
      if (projectCreated) await prisma.project.deleteMany({ where: { id: projectId } })
      if (artifactCreated) await prisma.artifact.deleteMany({ where: { id: artifactId } })
      if (providerCreated) await prisma.reamonProvider.deleteMany({ where: { id: providerId } })
      if (userCreated) await prisma.user.deleteMany({ where: { id: userId } })
      if (benchmarkEvidencePath && directEvidence) {
        const evidence = createPyInstallerBenchmarkEvidence({
          fixtureId: process.env.REAMON_BENCHMARK_FIXTURE_ID || 'pyinstaller-module-paging-linux-amd64',
          artifactSha256: fixtureSha256,
          ...directEvidence,
          workerTerminalPage: workerReachedTerminalPage,
        })
        await mkdir(path.dirname(path.resolve(benchmarkEvidencePath)), { recursive: true })
        await writeFile(path.resolve(benchmarkEvidencePath), `${JSON.stringify(evidence, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        })
      }
    } finally {
      await Promise.all([
        rm(path.join(derivedRoot, projectId), { recursive: true, force: true }),
        rm(path.join(artifactsRoot, '.reamon-pycdc-output', projectId), { recursive: true, force: true }),
        rm(path.join(artifactsRoot, '.reamon-pyinstaller-output', projectId), { recursive: true, force: true }),
        ...(path.resolve(fixturePath) === path.join(artifactsRoot, 'qa', 'pyinstaller-db-integration', 'fixture')
          ? [rm(path.resolve(fixturePath), { force: true })]
          : []),
      ])
      await prisma.$disconnect()
    }
  }, 30_000)

  test('persists paged module attempts and keeps known recovered semantics addressable', async () => {
    let lastResult: Awaited<ReturnType<typeof executePyInstaller>> | undefined
    for (let index = 0; index < 38; index += 1) {
      const taskId = `pyi-db-task-${index}-${suffix}`
      await prisma.task.create({
        data: {
          id: taskId,
          projectId,
          artifactId,
          providerId,
          capability: 'decompile',
          title: `Persist PyInstaller page continuation ${index + 1}`,
          status: 'COMPLETED',
          options: { requiresApproval: false },
        },
      })

      const input: ToolExecutionInput = {
        targetProfile: profile,
        projectId,
        artifactId,
        taskId,
        runToken: `run-${index}-${suffix}`,
        artifactPath: path.resolve(fixturePath),
        artifactRelativePath: 'pyinstaller-fixture',
      }
      let result: Awaited<ReturnType<typeof executePyInstaller>>
      for (let retry = 0; ; retry += 1) {
        result = await executePyInstaller(input)
        if (result.status === 'completed' || !/extraction worker is busy/i.test(result.error || '') || retry >= 4) break
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      expect(result.status, result.status === 'failed' ? result.error : undefined).toBe('completed')
      lastResult = result
      await prisma.$transaction((tx) => ingestToolResult(tx, {
        projectId,
        taskId,
        targetId: null,
        artifactId,
        source: result.toolId,
        data: result.data,
        maxObservations: 10_000,
      }))
    }
    expect(lastResult?.data.modulePageOffset).toBe(148)
    expect(lastResult?.data.nextModulePageOffset).toBe(180)

    const rows = await prisma.reamonObservation.findMany({
      where: { projectId, artifactId, source: 'reamon-pyinstaller', type: 'code_unit' },
      select: { stableKey: true, attributes: true },
      take: 10_000,
    })
    const moduleRows = rows.map((row) => ({
      key: row.stableKey,
      attributes: row.attributes as Record<string, unknown>,
    })).filter(({ attributes }) => attributes.sourceExecutableSha256)
    expect(moduleRows).toHaveLength(180)
    const persistedIndexes = new Set(moduleRows.map(({ attributes }) => attributes.pyinstallerModuleIndex))
    expect(persistedIndexes.has(0)).toBe(true)
    expect(persistedIndexes.has(63)).toBe(true)
    expect(persistedIndexes.has(64)).toBe(true)
    expect(persistedIndexes.has(127)).toBe(true)
    expect(persistedIndexes.has(151)).toBe(true)
    expect(persistedIndexes.has(179)).toBe(true)
    expect(moduleRows.some(({ attributes }) => attributes.pyinstallerModuleIndex === 64
      && attributes.pyinstallerDecompilationAttempted === true)).toBe(true)

    let knownSourceMatchedCount = 0
    let reconstructionMatchedCount = 0
    let structuredMutationRejectedCount = 0
    let structuredMutationFalseAcceptanceCount = 0
    let originalSourceFalseAcceptanceCount = 0
    const fixtureId = process.env.REAMON_BENCHMARK_FIXTURE_ID
    const isStructuredFixture = isPyInstallerStructuredSourceFixture(fixtureId ?? '')
      || fixtureId === PYINSTALLER_MUTATED_SOURCE_CONTROL_FIXTURE_ID
    const isMutatedArtifactFixture = fixtureId === PYINSTALLER_MUTATED_SOURCE_CONTROL_FIXTURE_ID
    for (let moduleValue = 1; moduleValue <= 70; moduleValue += 1) {
      const moduleName = `module_${String(moduleValue - 1).padStart(3, '0')}`
      const knownModule = moduleRows.find(({ attributes }) => attributes.pyinstallerArchivePath === `PYZ.pyz_extracted/paging_fixture/${moduleName}.pyc`)
      expect(knownModule, `${moduleName} should remain addressable after page continuation`).toBeDefined()
      expect(knownModule!.attributes.pyinstallerDecompilationAttempted).toBe(true)
      expect(knownModule!.attributes.decompiled).toBe(true)
      expect(typeof knownModule!.attributes.codeArtifactId).toBe('string')
      const knownSourcePath = path.resolve(derivedRoot, ...(knownModule!.attributes.codeArtifactId as string).replaceAll('\\', '/').split('/'))
      expect(knownSourcePath.startsWith(`${derivedRoot}${path.sep}`)).toBe(true)
      const knownSourceText = await readFile(knownSourcePath, 'utf8')
      expect(knownModule!.attributes.codeArtifactSha256).toBe(createHash('sha256').update(knownSourceText).digest('hex'))
      expect(knownSourceText).toMatch(new RegExp(`\\bVALUE\\s*=\\s*${moduleValue}\\b`))
      const sourceMatches = isStructuredFixture
        ? matchesPyInstallerStructuredFixtureSource(knownSourceText, moduleValue, isMutatedArtifactFixture ? 'under' : 'below')
        : matchesPyInstallerFixtureSource(knownSourceText, moduleValue)
      if (sourceMatches) reconstructionMatchedCount += 1
      if (isMutatedArtifactFixture
        && matchesPyInstallerStructuredFixtureSource(knownSourceText, moduleValue, 'below')) {
        originalSourceFalseAcceptanceCount += 1
      }
      if (isStructuredFixture && !isMutatedArtifactFixture) {
        const mutatedSource = mutatePyInstallerStructuredFixtureSource(knownSourceText)
        expect(mutatedSource, `${moduleName} must expose exactly one mutation target`).toBeDefined()
        if (matchesPyInstallerStructuredFixtureSource(mutatedSource!, moduleValue)) {
          structuredMutationFalseAcceptanceCount += 1
        } else {
          structuredMutationRejectedCount += 1
        }
      }
      knownSourceMatchedCount += 1
    }
    expect(knownSourceMatchedCount).toBe(70)
    if (isStructuredFixture) {
      expect(reconstructionMatchedCount).toBe(70)
      if (isMutatedArtifactFixture) {
        expect(originalSourceFalseAcceptanceCount).toBe(0)
      } else {
        expect(structuredMutationRejectedCount).toBe(70)
        expect(structuredMutationFalseAcceptanceCount).toBe(0)
      }
    }

    directEvidence = {
      extractedModuleCount: moduleRows.length,
      knownSourceMatchedCount,
      reconstructionMatchedCount,
      ...(isStructuredFixture && !isMutatedArtifactFixture
        ? { structuredMutationRejectedCount, structuredMutationFalseAcceptanceCount }
        : {}),
      ...(isMutatedArtifactFixture ? { originalSourceFalseAcceptanceCount } : {}),
    }
  }, 30 * 60_000)

  test.skipIf(!runWorkerIntegration)('completes a queued PyInstaller task through the live worker', async ({ skip }) => {
    if (await prisma.task.count({ where: { status: 'QUEUED' } })) {
      skip('The live task queue is not empty; avoid consuming unrelated work during integration acceptance')
    }

    const taskId = `pyi-db-worker-${suffix}`
    await prisma.task.create({
      data: {
        id: taskId,
        projectId,
        artifactId,
        providerId,
        capability: 'decompile',
        title: 'Verify PyInstaller execution through the live worker',
        options: { requiresApproval: false },
      },
    })

    const deadline = Date.now() + 5 * 60_000
    let task = await prisma.task.findUnique({ where: { id: taskId } })
    while (task && ['QUEUED', 'RUNNING'].includes(task.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      task = await prisma.task.findUnique({ where: { id: taskId } })
    }
    expect(task, 'the live worker did not settle the queued PyInstaller task').toBeDefined()
    expect(task!.status, task!.error).toBe('COMPLETED')
    expect(task!.result).toMatchObject({ modulePageOffset: 152, nextModulePageOffset: 180 })

    const recovered = await prisma.reamonObservation.findFirst({
      where: {
        projectId,
        artifactId,
        source: 'reamon-pyinstaller',
        type: 'code_unit',
        attributes: { path: ['pyinstallerModuleIndex'], equals: 68 },
      },
      select: { attributes: true },
    })
    expect(recovered?.attributes).toMatchObject({ pyinstallerDecompilationAttempted: true, decompiled: true })
    const codeArtifactId = (recovered!.attributes as Record<string, unknown>).codeArtifactId
    expect(typeof codeArtifactId).toBe('string')
    const sourcePath = path.resolve(derivedRoot, ...(codeArtifactId as string).replaceAll('\\', '/').split('/'))
    expect(sourcePath.startsWith(`${derivedRoot}${path.sep}`)).toBe(true)
    expect((await readFile(sourcePath, 'utf8')).trim().length).toBeGreaterThan(0)
    workerReachedTerminalPage = true
  }, 6 * 60_000)
})

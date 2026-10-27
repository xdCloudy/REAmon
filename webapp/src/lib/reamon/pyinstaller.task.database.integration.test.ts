/** @vitest-environment node */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import prisma from '@/lib/prisma'
import { ingestToolResult } from './result-ingestion'
import { executePyInstaller } from './pyinstaller'
import type { TargetProfile, ToolExecutionInput } from './types'

const enabled = process.env.REAMON_RUN_DB_INTEGRATION === '1'
  && Boolean(process.env.REAMON_PYINSTALLER_URL && process.env.REAMON_PYCDC_URL)
  && Boolean(process.env.REAMON_PYINSTALLER_FIXTURE_PATH)
  && Boolean(process.env.REAMON_ARTIFACTS_PATH && process.env.REAMON_DERIVED_PATH)
const describeDatabase = describe.skipIf(!enabled)

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

  beforeAll(async () => {
    const absoluteFixture = path.resolve(fixturePath)
    if (!absoluteFixture.startsWith(`${artifactsRoot}${path.sep}`)) {
      throw new Error('PyInstaller DB fixture must live inside REAMON_ARTIFACTS_PATH')
    }
    const fixture = await readFile(absoluteFixture)
    const fixtureStat = await stat(absoluteFixture)
    const sha256 = createHash('sha256').update(fixture).digest('hex')

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

  test('persists module attempts, advances to index 64, and keeps recovered source addressable', async () => {
    let lastResult: Awaited<ReturnType<typeof executePyInstaller>> | undefined
    for (let index = 0; index < 17; index += 1) {
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
    expect(lastResult?.data.modulePageOffset).toBe(64)
    expect(lastResult?.data.nextModulePageOffset).toBe(128)

    const rows = await prisma.reamonObservation.findMany({
      where: { projectId, artifactId, source: 'reamon-pyinstaller', type: 'code_unit' },
      select: { stableKey: true, attributes: true },
      take: 10_000,
    })
    const moduleRows = rows.map((row) => ({
      key: row.stableKey,
      attributes: row.attributes as Record<string, unknown>,
    })).filter(({ attributes }) => attributes.sourceExecutableSha256)
    const persistedIndexes = new Set(moduleRows.map(({ attributes }) => attributes.pyinstallerModuleIndex))
    expect(persistedIndexes.has(0)).toBe(true)
    expect(persistedIndexes.has(63)).toBe(true)
    expect(persistedIndexes.has(64)).toBe(true)
    expect(persistedIndexes.has(127)).toBe(true)
    expect(moduleRows.some(({ attributes }) => attributes.pyinstallerModuleIndex === 64
      && attributes.pyinstallerDecompilationAttempted === true)).toBe(true)

    const recovered = moduleRows.find(({ attributes }) => attributes.decompiled === true && typeof attributes.codeArtifactId === 'string')
    expect(recovered, 'at least one pycdc source unit should be committed to PostgreSQL').toBeDefined()
    const relativeSourcePath = (recovered!.attributes.codeArtifactId as string).replaceAll('\\', '/')
    const sourcePath = path.resolve(derivedRoot, ...relativeSourcePath.split('/'))
    expect(sourcePath.startsWith(`${derivedRoot}${path.sep}`)).toBe(true)
    const source = await readFile(sourcePath, 'utf8')
    expect(source.trim().length).toBeGreaterThan(0)
  }, 30 * 60_000)
})

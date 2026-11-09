/** @vitest-environment node */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import prisma from '@/lib/prisma'
import { indexToCodeWorkspaceImport } from './tocode-import'

const enabled = process.env.REAMON_RUN_DB_INTEGRATION === '1'
  && Boolean(process.env.DATABASE_URL)
const describeDatabase = describe.skipIf(!enabled)

describeDatabase('ToCode export indexing with PostgreSQL persistence', () => {
  const suffix = randomUUID()
  const userId = `tocode-db-user-${suffix}`
  const projectId = `tocode-db-project-${suffix}`
  const importId = `tocode-db-import-${suffix}`
  const folderImportId = `tocode-db-folder-import-${suffix}`
  const artifactsRoot = path.resolve(process.env.REAMON_ARTIFACTS_PATH || '/tmp/reamon-tocode-artifacts')
  const derivedRoot = path.resolve(process.env.REAMON_DERIVED_PATH || '/tmp/reamon-tocode-derived')
  const fixtureRoot = path.join(artifactsRoot, 'qa', 'tocode-import', suffix)
  const originalArtifactBytes = new Map<string, Buffer>()
  let projectCreated = false
  let userCreated = false

  beforeAll(async () => {
    process.env.REAMON_ARTIFACTS_PATH = artifactsRoot
    process.env.REAMON_DERIVED_PATH = derivedRoot
    await prisma.user.create({ data: { id: userId, name: 'ToCode DB test', email: `${suffix}@example.invalid` } })
    userCreated = true
    await prisma.project.create({ data: { id: projectId, userId, name: 'ToCode indexing integration' } })
    projectCreated = true
    await prisma.workspaceImport.create({
      data: {
        id: importId,
        projectId,
        sourceType: 'BROWSER_DIRECTORY',
        rootName: 'synthetic-tocode-export',
        status: 'COMPLETED',
        completedFiles: 4,
        totalFiles: 4,
      },
    })

    const source = [
      'int main(void) {',
      '  return helper(7);',
      '}',
      '',
      'int helper(int value) {',
      '  return value + 1;',
      '}',
      '',
    ].join('\n')
    const assembly = 'main:\n  call helper\n  ret\n'
    const files: Record<string, Buffer> = {
      'export/export-manifest.json': Buffer.from(JSON.stringify({ format: 'ToCode', version: 'fixture-1' })),
      'export/functions.json': Buffer.from(JSON.stringify({ functions: [
        { address: '0x401000', name: 'main', prototype: 'int main(void)', size: 12, source_file: 'src/main.c', source_line_start: 1, source_line_end: 3, asm_file: 'asm/main.asm', asm_line_start: 1, asm_line_end: 3, callees: ['0x401020'] },
        { address: '0x401020', name: 'helper', prototype: 'int helper(int value)', size: 8, source_file: 'src/main.c', source_line_start: 5, source_line_end: 7 },
      ] })),
      'export/src/main.c': Buffer.from(source),
      'export/asm/main.asm': Buffer.from(assembly),
    }
    await Promise.all(Object.entries(files).map(async ([relativePath, bytes]) => {
      const storagePath = path.posix.join('qa', 'tocode-import', suffix, relativePath)
      const absolutePath = path.join(artifactsRoot, ...storagePath.split('/'))
      await mkdir(path.dirname(absolutePath), { recursive: true })
      await writeFile(absolutePath, bytes)
      originalArtifactBytes.set(relativePath, bytes)
      await prisma.artifact.create({
        data: {
          projectId,
          importId,
          name: path.posix.basename(relativePath),
          originalName: path.posix.basename(relativePath),
          relativePath,
          parentPath: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
          storagePath,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: BigInt(bytes.byteLength),
          extension: path.posix.extname(relativePath).slice(1),
          mimeType: 'application/octet-stream',
        },
      })
    }))
  }, 30_000)

  afterAll(async () => {
    try {
      if (projectCreated) await prisma.project.deleteMany({ where: { id: projectId } })
      if (userCreated) await prisma.user.deleteMany({ where: { id: userId } })
    } finally {
      await Promise.all([
        rm(fixtureRoot, { recursive: true, force: true }),
        rm(path.join(derivedRoot, projectId), { recursive: true, force: true }),
      ])
      await prisma.$disconnect()
    }
  }, 30_000)

  test('indexes functions, resolves calls, and copies hash-verified pseudocode and assembly', async () => {
    const result = await indexToCodeWorkspaceImport(projectId, importId)

    expect(result).toMatchObject({
      exportCount: 1,
      discoveredFunctions: 2,
      indexedFunctions: 2,
      skippedFunctions: 0,
      callEdges: 1,
      copiedSourceAndAssemblyFiles: 2,
      copiedSourceAndAssemblyBytes: originalArtifactBytes.get('export/src/main.c')!.byteLength
        + originalArtifactBytes.get('export/asm/main.asm')!.byteLength,
      alreadyIndexed: false,
    })

    const task = await prisma.task.findUniqueOrThrow({
      where: { id: result.taskId },
      select: { status: true, result: true },
    })
    expect(task.status).toBe('COMPLETED')
    expect(task.result).toMatchObject({ indexedFunctions: 2, callEdges: 1 })

    const observations = await prisma.reamonObservation.findMany({
      where: { projectId, taskId: result.taskId, source: 'reamon-tocode-import' },
      select: { type: true, label: true, fromKey: true, toKey: true, attributes: true },
    })
    const codeUnits = observations.filter((observation) => observation.type === 'code_unit')
    const call = observations.find((observation) => observation.type === 'calls')
    expect(codeUnits.map((unit) => unit.label).sort()).toEqual(['helper', 'main'])
    expect(call).toMatchObject({ type: 'calls', label: 'main calls helper' })

    const main = codeUnits.find((unit) => unit.label === 'main')!
    const attributes = main.attributes as Record<string, unknown>
    expect(attributes).toMatchObject({ decompiler: 'ToCode', representation: 'pseudocode', relativePath: 'src/main.c' })
    for (const [attribute, sourceRelativePath] of [
      ['codeArtifactId', 'export/src/main.c'],
      ['disassemblyArtifactId', 'export/asm/main.asm'],
    ] as const) {
      const derivedRelativePath = attributes[attribute]
      expect(typeof derivedRelativePath).toBe('string')
      const derivedPath = path.resolve(derivedRoot, derivedRelativePath as string)
      expect(path.relative(path.join(derivedRoot, projectId), derivedPath).startsWith('..')).toBe(false)
      const original = originalArtifactBytes.get(sourceRelativePath)!
      const copied = await readFile(derivedPath)
      expect(copied).toEqual(original)
      expect(createHash('sha256').update(copied).digest('hex')).toBe(createHash('sha256').update(original).digest('hex'))
    }

    const [evidence, activity, workspaceImport] = await Promise.all([
      prisma.evidence.findMany({ where: { projectId, source: 'reamon-tocode-import' } }),
      prisma.workspaceActivity.findMany({ where: { projectId, eventType: 'analysis.task.completed' } }),
      prisma.workspaceImport.findUniqueOrThrow({ where: { id: importId }, select: { metadata: true } }),
    ])
    expect(evidence).toHaveLength(1)
    expect(activity).toHaveLength(1)
    expect(workspaceImport.metadata).toMatchObject({ toCodeIndex: { status: 'COMPLETED', taskId: result.taskId, indexedFunctions: 2 } })

    const repeated = await indexToCodeWorkspaceImport(projectId, importId)
    expect(repeated).toMatchObject({ taskId: result.taskId, indexedFunctions: 2, alreadyIndexed: true })
    expect(await prisma.task.count({ where: { projectId } })).toBe(1)
  }, 60_000)

  test('matches folder inputs by exact digest and resolves explicit cross-binary call sites', async () => {
    await prisma.workspaceImport.create({
      data: {
        id: folderImportId,
        projectId,
        sourceType: 'BROWSER_DIRECTORY',
        rootName: 'synthetic-tocode-folder-export',
        status: 'COMPLETED',
        completedFiles: 11,
        totalFiles: 11,
      },
    })

    const clientBinary = Buffer.from('synthetic-client-binary')
    const libraryBinary = Buffer.from('synthetic-library-binary')
    const clientSha256 = createHash('sha256').update(clientBinary).digest('hex')
    const librarySha256 = createHash('sha256').update(libraryBinary).digest('hex')
    const mappingLinks = [
      {
        importer: 'bin/client.bin',
        symbol: 'helper',
        status: 'bound',
        target: 'bin/library.bin',
        target_export_dir: 'exports/library',
        target_status: 'decompiled',
        export: 'helper',
        target_va: '0x2000',
        resolution: 'two_level',
        target_function: {
          address: '0x2000',
          name: 'helper',
          source_file: 'src/helper.c',
          line_start: 1,
          line_end: 3,
        },
        call_sites: Array.from({ length: 17 }, () => ({
          address: '0x1000',
          name: 'entry',
          source_file: 'src/main.c',
          line_start: 1,
          line_end: 3,
        })),
      },
      {
        importer: 'bin/client.bin',
        symbol: 'unreferenced',
        status: 'bound',
        target: 'bin/library.bin',
        target_export_dir: 'exports/library',
        target_function: {
          address: '0x2000',
          name: 'helper',
          source_file: 'src/helper.c',
          line_start: 1,
          line_end: 3,
        },
        call_sites: [],
      },
      {
        importer: 'bin/client.bin',
        symbol: 'missing_symbol',
        status: 'unresolved_symbol',
        target: 'bin/library.bin',
      },
      ...Array.from({ length: 99_998 }, () => ({
        importer: 'bin/client.bin',
        symbol: 'outside_folder',
        status: 'no_definer_in_folder',
      })),
    ]
    const files: Record<string, Buffer> = {
      'project.json': Buffer.from(JSON.stringify({
        kind: 'folder',
        tocode_version: 'fixture-folder-1',
        inventory: 'inventory.json',
        binaries: [
          { path: 'bin/client.bin', export_dir: 'exports/client' },
          { path: 'bin/library.bin', export_dir: 'exports/library' },
        ],
      })),
      'inventory.json': Buffer.from(JSON.stringify({ files: [
        { path: 'bin/client.bin', size: clientBinary.byteLength, sha256: clientSha256 },
        { path: 'bin/library.bin', size: libraryBinary.byteLength, sha256: '0'.repeat(64) },
      ] })),
      'mappings.json': Buffer.from(JSON.stringify({
        schema_version: 1,
        summary: { imports: mappingLinks.length, bound_in_folder: 2, mapped_to_function: 2 },
        links: mappingLinks,
      })),
      'bin/client.bin': clientBinary,
      'bin/library.bin': libraryBinary,
      'exports/client/export-manifest.json': Buffer.from(JSON.stringify({ kind: 'native', tocode_version: 'fixture-folder-1' })),
      'exports/client/functions.json': Buffer.from(JSON.stringify({ functions: [
        { address: '0x1000', name: 'entry', prototype: 'int entry(void)', size: 12, source_file: 'src/main.c', source_line_start: 1, source_line_end: 3 },
      ] })),
      'exports/client/src/main.c': Buffer.from('int entry(void) {\n  return helper();\n}\n'),
      'exports/library/export-manifest.json': Buffer.from(JSON.stringify({ kind: 'native', tocode_version: 'fixture-folder-1' })),
      'exports/library/functions.json': Buffer.from(JSON.stringify({ functions: [
        { address: '0x2000', name: 'helper', prototype: 'int helper(void)', size: 8, source_file: 'src/helper.c', source_line_start: 1, source_line_end: 3 },
      ] })),
      'exports/library/src/helper.c': Buffer.from('int helper(void) {\n  return 7;\n}\n'),
    }
    const artifactIds = new Map<string, string>()
    await Promise.all(Object.entries(files).map(async ([relativePath, bytes]) => {
      const storagePath = path.posix.join('qa', 'tocode-import', suffix, 'folder', relativePath)
      const absolutePath = path.join(artifactsRoot, ...storagePath.split('/'))
      await mkdir(path.dirname(absolutePath), { recursive: true })
      await writeFile(absolutePath, bytes)
      const artifact = await prisma.artifact.create({
        data: {
          projectId,
          importId: folderImportId,
          name: path.posix.basename(relativePath),
          originalName: path.posix.basename(relativePath),
          relativePath,
          parentPath: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
          storagePath,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          sizeBytes: BigInt(bytes.byteLength),
          extension: path.posix.extname(relativePath).slice(1),
          mimeType: 'application/octet-stream',
        },
      })
      artifactIds.set(relativePath, artifact.id)
    }))

    const result = await indexToCodeWorkspaceImport(projectId, folderImportId)
    expect(result).toMatchObject({
      exportCount: 2,
      discoveredFunctions: 2,
      indexedFunctions: 2,
      callEdges: 1,
      crossBinaryCallEdges: 1,
      folderMappings: {
        status: 'PARSED',
        totalLinks: 100_001,
        consideredLinks: 100_000,
        omittedLinks: 1,
        edgeRowsVisited: 100_000,
        edgeResolutionTruncated: false,
        statusCounts: [
          { status: 'bound', count: 2 },
          { status: 'no_definer_in_folder', count: 99_997 },
          { status: 'unresolved_symbol', count: 1 },
        ],
        unlistedStatusLinks: 0,
        linksWithoutStatus: 0,
        nonBoundLinks: 99_998,
        boundLinksWithoutResolvedTarget: 0,
        boundLinksWithoutCallSites: 1,
        callSitesOmittedByPerLinkLimit: 1,
        callSitesWithoutResolvedCaller: 0,
      },
      toCodeExportsWithInputHash: 2,
      toCodeInputHashesMatchedToImportedArtifacts: 1,
      toCodeInputHashesNotFoundInImport: 1,
      copiedSourceAndAssemblyFiles: 2,
      alreadyIndexed: false,
    })

    const observations = await prisma.reamonObservation.findMany({
      where: { projectId, taskId: result.taskId, source: 'reamon-tocode-import' },
      select: { type: true, label: true, attributes: true },
    })
    const codeUnits = observations.filter((observation) => observation.type === 'code_unit')
    const entry = codeUnits.find((unit) => unit.label === 'entry')
    const helper = codeUnits.find((unit) => unit.label === 'helper')
    expect((entry?.attributes as Record<string, unknown>)).toMatchObject({
      toCodeInputProvenance: 'HASH_MATCHED_IMPORTED_ARTIFACT',
      toCodeInputArtifactId: artifactIds.get('bin/client.bin'),
      toCodeInputArtifactSha256: clientSha256,
      toCodeInputRelativePath: 'bin/client.bin',
    })
    expect((helper?.attributes as Record<string, unknown>)).toMatchObject({
      toCodeInputProvenance: 'HASH_NOT_IMPORTED',
      toCodeClaimedInputSha256: '0'.repeat(64),
    })
    expect(observations.find((observation) => observation.type === 'calls')).toMatchObject({
      label: 'entry calls helper · helper',
      attributes: {
        source: 'ToCode mappings.json',
        importer: 'exports/client',
        target: 'exports/library',
        importSymbol: 'helper',
        resolution: 'two_level',
      },
    })

    const metadata = await prisma.workspaceImport.findUniqueOrThrow({
      where: { id: folderImportId },
      select: { metadata: true },
    })
    expect(metadata.metadata).toMatchObject({
      toCodeIndex: { status: 'COMPLETED', taskId: result.taskId, indexedFunctions: 2 },
    })
  }, 60_000)
})

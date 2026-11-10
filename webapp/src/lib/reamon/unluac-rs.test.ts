/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { executeUnluacRs } from './unluac-rs'
import type { ToolExecutionInput } from './types'

const input: ToolExecutionInput = {
  targetProfile: { targetType: 'FILE', format: 'luac', extension: 'luac' },
  artifactId: 'artifact-lua',
  projectId: 'project-lua',
  taskId: 'task-lua',
  runToken: 'run-lua',
  artifactPath: '/data/reamon-artifacts/project-lua/module.luac',
  artifactRelativePath: 'module.luac',
}

const liveAnalyzerEnabled = process.env.REAMON_RUN_UNLUAC_RS_INTEGRATION === '1'
  && Boolean(process.env.REAMON_UNLUAC_RS_URL)
  && Boolean(process.env.REAMON_LUA_FIXTURE_PATH)
  && Boolean(process.env.REAMON_DERIVED_PATH)

function prototype(protoId: number, children: number[]) {
  return {
    protoId,
    name: null,
    lineStart: 0,
    lineEnd: 0,
    numParams: 0,
    isVararg: false,
    numUpvalues: 0,
    numConstants: 0,
    numInstructions: 0,
    instructionMnemonics: [],
    children,
    constants: [],
    cfg: {
      entryBlock: 0,
      exitBlock: 0,
      blockCount: 0,
      edgeCount: 0,
      blockOrder: [],
      blocks: [],
      edges: [],
    },
  }
}

function analyzerResponse(functions: ReturnType<typeof prototype>[], protoCount: number, metadataTruncated = false) {
  return {
    status: 'completed',
    toolVersion: 'unluac-rs@1.4.4',
    dialect: 'lua5.4',
    language: 'Lua',
    vectorConstructor: null,
    vectorSize: null,
    input: { relativePath: 'module.luac', sha256: 'a'.repeat(64) },
    unit: { name: 'module', relativePath: 'module.lua', codeArtifactId: 'derived/module.lua', sizeBytes: 64 },
    functions,
    protoCount,
    metadataTruncated,
    codeBytes: 64,
  }
}

function configureAnalyzerResponse(response: ReturnType<typeof analyzerResponse>) {
  vi.stubEnv('REAMON_UNLUAC_RS_URL', 'http://unluac-rs:8018')
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })))
}

describe('unluac-rs provider', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('emits the full module and nested-prototype containment tree', async () => {
    configureAnalyzerResponse(analyzerResponse([
      prototype(0, [1]),
      prototype(1, [2]),
      prototype(2, []),
    ], 3))

    const result = await executeUnluacRs(input)

    expect(result.status).toBe('completed')
    const observations = result.data.observations as Array<{
      kind: string
      type: string
      key: string
      relation?: string
      fromKey?: string
      toKey?: string
      attributes: Record<string, unknown>
    }>
    const codeUnit = observations.find((observation) => observation.kind === 'entity' && observation.type === 'code_unit')
    const prototypes = observations.filter((observation) => observation.kind === 'entity' && observation.type === 'function')
    const contains = observations.filter((observation) => observation.kind === 'relationship' && observation.relation === 'contains')

    expect(codeUnit).toBeDefined()
    expect(prototypes.map((observation) => observation.attributes.protoId)).toEqual([1, 2])
    expect(contains.map(({ fromKey, toKey }) => JSON.stringify([fromKey, toKey])).sort()).toEqual([
      JSON.stringify([codeUnit?.key, prototypes[0].key]),
      JSON.stringify([prototypes[0].key, prototypes[1].key]),
    ].sort())
  })

  it.each([
    ['duplicate prototype IDs', [prototype(0, [1]), prototype(1, []), prototype(1, [])], 3],
    ['cyclic prototype children', [prototype(0, []), prototype(1, [2]), prototype(2, [1])], 3],
    ['missing child in complete metadata', [prototype(0, [1, 2]), prototype(1, [])], 3],
  ])('rejects %s instead of persisting a false hierarchy', async (_label, functions, protoCount) => {
    configureAnalyzerResponse(analyzerResponse(functions, protoCount))

    const result = await executeUnluacRs(input)

    expect(result.status).toBe('failed')
    expect(result.error).toBe('unluac-rs analyzer returned an invalid result')
  })

  it('keeps explicitly truncated prototype metadata as incomplete evidence', async () => {
    configureAnalyzerResponse(analyzerResponse([
      prototype(0, [1, 2]),
      prototype(1, []),
    ], 3, true))

    const result = await executeUnluacRs(input)

    expect(result.status).toBe('completed')
    expect(result.data).toMatchObject({ functionMetadataTruncated: true, truncated: false })
  })
})

describe.skipIf(!liveAnalyzerEnabled)('unluac-rs live analyzer hierarchy acceptance', () => {
  it('maps the real stripped Lua prototype tree and reads back its derived source', async () => {
    const suffix = randomUUID()
    const projectId = `lua-hierarchy-${suffix}`
    const derivedRoot = path.resolve(process.env.REAMON_DERIVED_PATH || '/data/reamon-derived')
    vi.stubEnv('REAMON_UNLUAC_RS_URL', process.env.REAMON_UNLUAC_RS_URL || '')
    const result = await executeUnluacRs({
      ...input,
      projectId,
      artifactId: `lua-artifact-${suffix}`,
      taskId: `lua-task-${suffix}`,
      runToken: `lua-run-${suffix}`,
      artifactPath: process.env.REAMON_LUA_FIXTURE_PATH,
    })

    try {
      expect(result.status).toBe('completed')
      const data = result.data as {
        observations: Array<{
          kind: string
          type: string
          key: string
          relation?: string
          fromKey?: string
          toKey?: string
          attributes: Record<string, unknown>
        }>
        functionMetadataTruncated: boolean
      }
      expect(data.functionMetadataTruncated).toBe(false)
      const codeUnit = data.observations.find((observation) => observation.kind === 'entity' && observation.type === 'code_unit')
      const prototypes = data.observations.filter((observation) => observation.kind === 'entity' && observation.type === 'function')
      const contains = data.observations.filter((observation) => observation.kind === 'relationship' && observation.relation === 'contains')
      expect(codeUnit).toBeDefined()
      expect(prototypes.length).toBeGreaterThan(0)

      const byProtoId = new Map(prototypes.map((prototype) => [prototype.attributes.protoId, prototype]))
      const nestedIds = new Set<number>()
      const expectedPairs = new Set<string>()
      for (const prototype of prototypes) {
        const childProtoIds = JSON.parse(String(prototype.attributes.childProtoIds)) as number[]
        for (const childProtoId of childProtoIds) {
          const child = byProtoId.get(childProtoId)
          expect(child, `prototype ${String(prototype.attributes.protoId)} child ${childProtoId}`).toBeDefined()
          expectedPairs.add(JSON.stringify([prototype.key, child?.key]))
          nestedIds.add(childProtoId)
        }
      }
      for (const prototype of prototypes) {
        const protoId = prototype.attributes.protoId
        if (typeof protoId === 'number' && !nestedIds.has(protoId)) {
          expectedPairs.add(JSON.stringify([codeUnit?.key, prototype.key]))
        }
      }
      expect(new Set(contains.map(({ fromKey, toKey }) => JSON.stringify([fromKey, toKey])))).toEqual(expectedPairs)

      const sourcePath = String(codeUnit?.attributes.codeArtifactId || '')
      const absoluteSourcePath = path.resolve(derivedRoot, ...sourcePath.replaceAll('\\', '/').split('/'))
      expect(absoluteSourcePath.startsWith(`${derivedRoot}${path.sep}`)).toBe(true)
      const source = await readFile(absoluteSourcePath)
      expect(source.byteLength).toBeGreaterThan(0)
      expect(source.byteLength).toBeLessThanOrEqual(32 * 1024 * 1024)
    } finally {
      await rm(path.join(derivedRoot, projectId), { recursive: true, force: true })
    }
  }, 5 * 60_000)
})

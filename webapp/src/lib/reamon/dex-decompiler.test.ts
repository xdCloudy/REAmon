/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeDexDecompiler } from './dex-decompiler'

const input = {
  targetProfile: { targetType: 'FILE' as const, format: 'apk', mimeType: 'application/vnd.android.package-archive', extension: 'apk', architecture: null, platform: 'Android', runtimes: ['Dalvik'], embeddedArtifacts: [], entropy: null, metadata: {} },
  artifactId: 'artifact-1', projectId: 'project-1', taskId: 'task-1', runToken: 'run-1', artifactPath: '/data/reamon-artifacts/project-1/a.apk',
}

function responseBody(failedClassDetails: unknown) {
  return {
    status: 'completed',
    toolVersion: 'd'.repeat(40),
    input: { sha256: 'a'.repeat(64), relativePath: 'project-1/a.apk' },
    discoveredClassCount: 1,
    returnedClassCount: 1,
    discoveredMethodCount: 0,
    returnedMethodCount: 0,
    methodsTruncated: false,
    methods: [],
    calls: [],
    callGraphTruncated: false,
    references: [],
    referencesTruncated: false,
    failedClassDetails,
    codeBytes: 32,
    truncated: false,
    units: [{ name: 'com.example.Main', relativePath: 'com/example/Main.java', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/com/example/Main.java', sizeBytes: 32 }],
    warnings: '',
  }
}

describe('Rust DEX-to-Java provider', () => {
  beforeEach(() => {
    vi.stubEnv('REAMON_DEX_DECOMPILER_URL', 'http://dex-decompiler-analyzer:8019')
    vi.stubGlobal('fetch', vi.fn())
  })

  it('retains bounded failed-class identities in the saved run result', async () => {
    const details = [{ dexEntry: 'classes2.dex', classIndex: 8, descriptor: 'Lcom/example/Broken;', reason: 'structured decompilation panicked' }]
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(responseBody(details)), { status: 200 }))

    const result = await executeDexDecompiler(input)

    expect(result.status).toBe('completed')
    expect(result.data.failedClassDetails).toEqual(details)
    expect(result.data.observations).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'fact',
      type: 'decompilation_failure',
      label: 'Lcom/example/Broken; could not be reconstructed',
      attributes: expect.objectContaining({
        identity: 'artifact-1:classes2.dex:8:Lcom/example/Broken;',
        dexEntry: 'classes2.dex',
        classIndex: 8,
        reason: 'structured decompilation panicked',
      }),
    })]))
  })

  it('preserves discovered and returned method counts when method evidence is capped', async () => {
    const body = {
      ...responseBody([]),
      discoveredMethodCount: 12_400,
      returnedMethodCount: 1,
      methodsTruncated: true,
      methods: [{
        signature: 'com.example.Main#start():void',
        className: 'com.example.Main',
        methodName: 'start',
        relativePath: 'com/example/Main.java',
        dexIndex: 0,
        methodIndex: 3,
        instructionCount: 2,
        instructionMnemonics: ['invoke-virtual', 'return-void'],
        controlFlowGraph: {},
        bytecodeRowsTruncated: false,
        cfgTruncated: false,
      }],
    }
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))

    const result = await executeDexDecompiler(input)

    expect(result.status).toBe('completed')
    expect(result.data).toMatchObject({
      discoveredMethodCount: 12_400,
      returnedMethodCount: 1,
      methodsTruncated: true,
    })
    expect(result.data.observations).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function' })]))
  })

  it('persists streamed method pages while keeping them out of the final task payload', async () => {
    const method = {
      signature: 'com.example.Main#start():void',
      className: 'com.example.Main',
      methodName: 'start',
      relativePath: 'com/example/Main.java',
      dexIndex: 0,
      methodIndex: 3,
      instructionCount: 2,
      instructionMnemonics: ['invoke-virtual', 'return-void'],
      controlFlowGraph: {},
      bytecodeRowsTruncated: false,
      cfgTruncated: false,
    }
    const body = responseBody([])
    const metadata = Object.fromEntries(Object.entries(body).filter(([key]) => !['units', 'methods', 'calls', 'references'].includes(key)))
    const events = [
      { type: 'result_start', data: { ...metadata, discoveredMethodCount: 1, returnedMethodCount: 1 }, arrayFields: ['units', 'methods', 'calls', 'references'] },
      { type: 'result_chunk', field: 'units', items: body.units },
      { type: 'result_chunk', field: 'methods', items: [method] },
      { type: 'result_end' },
    ].map((event) => JSON.stringify(event)).join('\n')
    vi.mocked(fetch).mockResolvedValue(new Response(events, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    }))
    const persistObservationBatch = vi.fn(async (observations) => observations.length)

    const result = await executeDexDecompiler({ ...input, persistObservationBatch })

    expect(result.status).toBe('completed')
    expect(result.data).toMatchObject({ returnedMethodCount: 1, streamedFunctionObservationCount: 1 })
    expect(result.data.observations).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function' })]))
    expect(persistObservationBatch).toHaveBeenCalledWith([expect.objectContaining({
      type: 'function',
      label: 'com.example.Main#start',
      attributes: expect.objectContaining({
        decompilationEngineVersion: 'd'.repeat(40),
        sourceSha256: 'a'.repeat(64),
      }),
    })])
  })

  it('rejects malformed failed-class identities from the analyzer', async () => {
    const details = [{ dexEntry: 'classes2.dex', classIndex: -1, descriptor: 'Lcom/example/Broken;', reason: 'failed' }]
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(responseBody(details)), { status: 200 }))

    const result = await executeDexDecompiler(input)

    expect(result).toMatchObject({ status: 'failed', error: 'DEX decompiler returned an invalid result' })
  })
})

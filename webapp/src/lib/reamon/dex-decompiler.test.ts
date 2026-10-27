/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DexStreamMethodIndex, executeDexDecompiler } from './dex-decompiler'
import type { ToolObservation } from './types'

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

  it('keeps streamed method membership in a fixed-width index', () => {
    const index = new DexStreamMethodIndex(4_200_000)
    index.add(1, 65_535)
    index.add(0, 3)
    index.finalize()

    expect(index.has(0, 3)).toBe(true)
    expect(index.has(1, 65_535)).toBe(true)
    expect(index.has(1, 65_534)).toBe(false)
    expect(index.retainedMethodCount).toBe(2)
    expect(index.retainedBytes).toBe(4_200_000 * 8)
  })

  it('preserves early decompiled methods and deduplicates external stubs after many streamed methods', async () => {
    const methodCount = 50_002
    const method = (methodIndex: number) => ({
      signature: `com.example.Main#m${methodIndex}():void`,
      className: 'com.example.Main',
      methodName: `m${methodIndex}`,
      relativePath: 'com/example/Main.java',
      dexIndex: 0,
      methodIndex,
      instructionCount: 1,
      instructionMnemonics: ['return-void'],
      controlFlowGraph: {},
      bytecodeArtifactPath: `dex-0/method-${methodIndex}.json`,
      bytecodeRowsTruncated: false,
      cfgTruncated: false,
    })
    const methods = Array.from({ length: methodCount }, (_, methodIndex) => method(methodIndex))
    const methodSignature = (methodIndex: number) => `com.example.Main#m${methodIndex}():void`
    const externalSignature = 'android.util.Log#d(String,String):int'
    const calls = [
      {
        fromSignature: methodSignature(50_000), toSignature: externalSignature,
        fromRelativePath: 'com/example/Main.java', toRelativePath: 'android/util/Log.java',
        fromAddress: 'dex0:method#50000', toAddress: 'dex0:method#60000',
        fromDexIndex: 0, toDexIndex: 0, fromMethodIndex: 50_000, toMethodIndex: 60_000,
        callSiteCount: 1, offsets: [4],
      },
      {
        fromSignature: methodSignature(50_001), toSignature: externalSignature,
        fromRelativePath: 'com/example/Main.java', toRelativePath: 'android/util/Log.java',
        fromAddress: 'dex0:method#50001', toAddress: 'dex0:method#60000',
        fromDexIndex: 0, toDexIndex: 0, fromMethodIndex: 50_001, toMethodIndex: 60_000,
        callSiteCount: 1, offsets: [8],
      },
      {
        fromSignature: methodSignature(49_999), toSignature: methodSignature(0),
        fromRelativePath: 'com/example/Main.java', toRelativePath: 'com/example/Main.java',
        fromAddress: 'dex0:method#49999', toAddress: 'dex0:method#0',
        fromDexIndex: 0, toDexIndex: 0, fromMethodIndex: 49_999, toMethodIndex: 0,
        callSiteCount: 1, offsets: [12],
      },
    ]
    const body = {
      ...responseBody([]),
      discoveredMethodCount: methodCount,
      returnedMethodCount: methodCount,
      returnedCallCount: calls.length,
    }
    const metadata = Object.fromEntries(Object.entries(body).filter(([key]) => !['units', 'methods', 'calls', 'references'].includes(key)))
    const events = [
      JSON.stringify({ type: 'result_start', data: metadata, arrayFields: ['units', 'methods', 'calls', 'references'] }),
      JSON.stringify({ type: 'result_chunk', field: 'units', items: body.units }),
      ...Array.from({ length: Math.ceil(methods.length / 100) }, (_, page) => JSON.stringify({
        type: 'result_chunk', field: 'methods', items: methods.slice(page * 100, (page + 1) * 100),
      })),
      JSON.stringify({ type: 'result_chunk', field: 'calls', items: calls }),
      JSON.stringify({ type: 'result_end' }),
    ].join('\n')
    vi.mocked(fetch).mockResolvedValue(new Response(events, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    }))

    const observedFunctions = new Map<string, { count: number; observation: ToolObservation }>()
    const identitiesToCheck = new Set([
      `artifact-1:0:0:${methodSignature(0)}`,
      `artifact-1:0:60000:${externalSignature}`,
    ])
    const persistObservationBatch = vi.fn(async (batch: ToolObservation[]) => {
      for (const observation of batch) {
        const identity = observation.attributes.identity
        if (observation.type !== 'function' || typeof identity !== 'string' || !identitiesToCheck.has(identity)) continue
        const previous = observedFunctions.get(identity)
        observedFunctions.set(identity, { count: (previous?.count || 0) + 1, observation })
      }
      return batch.length
    })

    const result = await executeDexDecompiler({ ...input, persistObservationBatch })

    expect(result.status).toBe('completed')
    expect(result.data).toMatchObject({ returnedMethodCount: methodCount, streamedFunctionObservationCount: methodCount })
    expect(observedFunctions.get(`artifact-1:0:0:${methodSignature(0)}`)?.count).toBe(1)
    expect(observedFunctions.get(`artifact-1:0:60000:${externalSignature}`)).toMatchObject({
      count: 1,
      observation: { attributes: { externalOrUndecompiled: true } },
    })
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
      bytecodeArtifactPath: 'dex-0/method-3.json',
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
    expect(persistObservationBatch.mock.calls[0]?.[0][0]?.attributes).not.toHaveProperty('bytecodeArtifactPath')
  })

  it('persists paged call and symbol-reference evidence through the task batch writer', async () => {
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
    const call = {
      fromSignature: method.signature,
      toSignature: 'android.util.Log#d(String,String):int',
      fromRelativePath: method.relativePath,
      toRelativePath: 'android/util/Log.java',
      fromAddress: 'dex0:method#3',
      toAddress: 'dex0:method#99',
      fromDexIndex: 0,
      toDexIndex: 0,
      fromMethodIndex: 3,
      toMethodIndex: 99,
      callSiteCount: 1,
      offsets: [4],
    }
    const reference = {
      kind: 'field_read',
      fromSignature: method.signature,
      fromRelativePath: method.relativePath,
      fromDexIndex: 0,
      fromMethodIndex: 3,
      fromAddress: 'dex0:method#3',
      targetSignature: 'com.example.Main#count',
      targetName: 'count',
      targetNameTruncated: false,
      targetDexIndex: 0,
      targetIndex: 7,
      occurrenceCount: 1,
      offsets: [8],
    }
    const events = [
      { type: 'result_start', data: { ...metadata, discoveredMethodCount: 1, returnedMethodCount: 1 }, arrayFields: ['units', 'methods', 'calls', 'references'] },
      { type: 'result_chunk', field: 'units', items: body.units },
      { type: 'result_chunk', field: 'methods', items: [method] },
      { type: 'result_chunk', field: 'calls', items: [call] },
      { type: 'result_chunk', field: 'references', items: [reference] },
      { type: 'result_end' },
    ].map((event) => JSON.stringify(event)).join('\n')
    vi.mocked(fetch).mockResolvedValue(new Response(events, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    }))
    const persistObservationBatch = vi.fn(async (observations: Array<{ type: string }>) => observations.length)

    const result = await executeDexDecompiler({ ...input, persistObservationBatch })

    expect(result.status).toBe('completed')
    expect(result.data).toMatchObject({ callCount: 1, returnedCallCount: 1, referenceCount: 1 })
    expect(result.data.observations).not.toEqual(expect.arrayContaining([expect.objectContaining({ relation: 'calls' })]))
    const persisted = persistObservationBatch.mock.calls.flatMap(([batch]) => batch)
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'calls', relation: 'calls' }),
      expect.objectContaining({ type: 'reads_field', relation: 'reads_field' }),
      expect.objectContaining({ type: 'symbol' }),
    ]))
  })

  it('rejects malformed failed-class identities from the analyzer', async () => {
    const details = [{ dexEntry: 'classes2.dex', classIndex: -1, descriptor: 'Lcom/example/Broken;', reason: 'failed' }]
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(responseBody(details)), { status: 200 }))

    const result = await executeDexDecompiler(input)

    expect(result).toMatchObject({ status: 'failed', error: 'DEX decompiler returned an invalid result' })
  })
})

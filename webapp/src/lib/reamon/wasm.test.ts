/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeWasm, wasmManifest } from './wasm'
import type { ToolExecutionInput } from './types'

const input: ToolExecutionInput = {
  targetProfile: { targetType: 'FILE', format: 'wasm', extension: 'wasm' },
  artifactId: 'artifact-1',
  projectId: 'project-1',
  taskId: 'task-1',
  runToken: 'run-1',
  artifactPath: '/data/reamon-artifacts/project-1/sample.wasm',
}

const analyzerResult = {
  status: 'completed',
  toolVersion: '1.0.42',
  functionCount: 1,
  returnedUnits: 1,
  codeBytes: 100,
  truncated: false,
  units: [{
    name: '$main',
    address: '0',
    relativePath: 'functions/f00000.wat',
    codeArtifactId: 'project-1/artifact-1/task-1/run-1/functions/f00000.wat',
    sizeBytes: 50,
  }],
  warnings: '',
}

describe('WABT provider', () => {
  beforeEach(() => {
    vi.stubEnv('REAMON_WASM_URL', 'http://wasm-analyzer:8012/')
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('advertises WebAssembly disassembly', () => {
    expect(wasmManifest.acceptsFormats).toEqual(['wasm'])
    expect(wasmManifest.capabilities).toEqual(['disassemble'])
  })

  it('converts returned WAT functions to linked code units', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(analyzerResult), { status: 200 }))

    const result = await executeWasm(input)

    expect(result.status).toBe('completed')
    expect(result.data).toMatchObject({ wasmFunctionCount: 1, returnedFunctionCount: 1, wabtVersion: '1.0.42', codeBytes: 100 })
    expect(result.data.observations).toMatchObject([{
      type: 'code_unit',
      label: '$main',
      attributes: {
        unitType: 'function',
        language: 'WebAssembly Text (WAT)',
        decompiled: true,
        address: '0',
        codeArtifactId: 'project-1/artifact-1/task-1/run-1/functions/f00000.wat',
      },
    }])
    expect(fetch).toHaveBeenCalledWith('http://wasm-analyzer:8012/analyze', expect.objectContaining({
      method: 'POST',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    }))
  })

  it('forwards streamed analyzer progress before mapping the result', async () => {
    const reportProgress = vi.fn()
    vi.mocked(fetch).mockResolvedValue(new Response([
      JSON.stringify({ type: 'progress', message: 'Disassembled 1 of 1 functions' }),
      JSON.stringify({ type: 'result', data: analyzerResult }),
    ].join('\n'), { status: 200, headers: { 'content-type': 'application/x-ndjson' } }))

    const result = await executeWasm({ ...input, reportProgress })

    expect(result.status).toBe('completed')
    expect(reportProgress).toHaveBeenCalledWith('Disassembled 1 of 1 functions')
  })

  it('marks malformed function records as omitted and truncated', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      ...analyzerResult,
      units: [...analyzerResult.units, { name: 'bad', address: '1', codeArtifactId: '', sizeBytes: 0 }],
    }), { status: 200 }))

    const result = await executeWasm(input)

    expect(result.status).toBe('completed')
    expect(result.data).toMatchObject({ truncated: true, returnedFunctionCount: 1 })
    expect(result.data.warnings).toContain('1 invalid or excess function records were omitted.')
  })

  it('rejects an invalid analyzer response instead of indexing untrusted units', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ status: 'completed', units: [{ name: '$broken' }] }), { status: 200 }))

    const result = await executeWasm(input)

    expect(result.status).toBe('failed')
    expect(result.error).toBe('WABT analyzer returned an invalid result')
  })

  it('reports the analyzer error body on failed responses', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'Unsupported WebAssembly proposal' }), { status: 422 }))

    const result = await executeWasm(input)

    expect(result.status).toBe('failed')
    expect(result.error).toBe('Unsupported WebAssembly proposal')
  })
})

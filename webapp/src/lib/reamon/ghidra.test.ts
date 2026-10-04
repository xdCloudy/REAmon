/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeGhidra, ghidraManifest, ghidraPlugin } from './ghidra'

const input = {
  targetProfile: { targetType: 'FILE' as const, format: 'elf', mimeType: 'application/x-executable', extension: 'elf', architecture: 'x86_64', platform: 'unix-like', runtimes: ['native'], embeddedArtifacts: [], entropy: null, metadata: {} },
  artifactId: 'artifact-1', projectId: 'project-1', taskId: 'task-1', runToken: 'run-1', artifactPath: '/data/reamon-artifacts/project-1/a.elf',
}

describe('Ghidra provider', () => {
  beforeEach(() => {
    vi.stubEnv('REAMON_GHIDRA_URL', 'http://ghidra-analyzer:8011')
    vi.stubGlobal('fetch', vi.fn())
  })

  it('advertises native executable formats and decompilation', () => {
    expect(ghidraManifest.acceptsFormats).toEqual(['elf', 'pe', 'pe-dll', 'macho'])
    expect(ghidraManifest.capabilities).toContain('decompile')
    expect(ghidraPlugin.manifest).toBe(ghidraManifest)
  })

  it('converts function exports into linked code-unit observations', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', toolVersion: '12.1.4', functionCount: 1, visitedFunctionCount: 2, failedFunctionCount: 1, codeBytes: 64, returnedUnits: 1, truncated: false,
      units: [{ name: 'main', address: 'ram:00401000', relativePath: 'functions/main.c', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/functions/main.c', disassemblyArtifactId: 'project-1/artifact-1/task-1/run-1/assembly/main.asm', sizeBytes: 32 }],
      calls: [{ fromAddress: 'ram:00401000', toAddress: 'ram:00402000', fromName: 'main', toName: 'helper' }],
      callCount: 1,
      callGraphTruncated: false,
      warnings: '',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const result = await executeGhidra(input)
    expect(result.status).toBe('completed')
    expect(result.data).toMatchObject({ decompiledFunctionCount: 1, returnedFunctionCount: 1, callCount: 1, callGraphTruncated: false, visitedFunctionCount: 2, failedFunctionCount: 1, codeBytes: 64 })
    expect(result.data.observations).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'entity', type: 'function', label: 'helper',
    }), expect.objectContaining({
      kind: 'relationship', type: 'calls', fromKey: expect.stringMatching(/^ghidra:function:/), toKey: expect.stringMatching(/^ghidra:function-target:/),
    })]))
    expect(result.data.observations).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'entity', type: 'code_unit', key: expect.stringMatching(/^ghidra:function:[0-9a-f]{32}$/), label: 'main',
      attributes: expect.objectContaining({ unitType: 'function', address: 'ram:00401000', language: 'C', sizeBytes: 32, decompiled: true, disassemblyArtifactId: 'project-1/artifact-1/task-1/run-1/assembly/main.asm' }),
    })]))
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('http://ghidra-analyzer:8011/analyze', expect.objectContaining({ method: 'POST' }))
  })

  it('connects calls between decompiled functions to their code-unit identities', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', toolVersion: '12.1.4', functionCount: 2, returnedUnits: 2, truncated: false,
      units: [
        { name: 'main', address: 'ram:00401000', relativePath: 'functions/main.c', codeArtifactId: 'project-1/a/run/main.c', sizeBytes: 32 },
        { name: 'helper', address: 'ram:00402000', relativePath: 'functions/helper.c', codeArtifactId: 'project-1/a/run/helper.c', sizeBytes: 16 },
      ],
      calls: [{ fromAddress: 'ram:00401000', toAddress: 'ram:00402000', fromName: 'main', toName: 'helper' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const result = await executeGhidra(input)
    const observations = result.data.observations as Array<Record<string, unknown>>
    const main = observations.find((row) => row.type === 'code_unit' && row.label === 'main')
    const helper = observations.find((row) => row.type === 'code_unit' && row.label === 'helper')
    const call = observations.find((row) => row.kind === 'relationship' && row.type === 'calls')

    expect(call).toMatchObject({ fromKey: main?.key, toKey: helper?.key })
  })

  it('bounds exported call relationships before ingestion', async () => {
    const calls = Array.from({ length: 401 }, (_, index) => ({
      fromAddress: 'ram:00401000',
      toAddress: 'ram:' + (0x402000 + index).toString(16),
      fromName: 'main',
      toName: 'callee_' + index,
    }))
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', toolVersion: '12.1.4', functionCount: 1, returnedUnits: 1, truncated: false,
      units: [{ name: 'main', address: 'ram:00401000', relativePath: 'functions/main.c', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/functions/main.c', sizeBytes: 32 }],
      calls,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const result = await executeGhidra(input)

    expect(result.data).toMatchObject({ callCount: 400, callGraphTruncated: true, truncated: true })
    expect((result.data.observations as unknown[])).toHaveLength(801)
  })

  it('returns analyzer errors as failed tasks', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'unsupported file' }), { status: 422 }))
    const result = await executeGhidra(input)
    expect(result.status).toBe('failed')
    expect(result.error).toBe('unsupported file')
  })
})

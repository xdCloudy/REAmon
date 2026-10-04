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
      units: [{ name: 'main', address: 'ram:00401000', relativePath: 'functions/main.c', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/functions/main.c', sizeBytes: 32 }],
      warnings: '',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const result = await executeGhidra(input)
    expect(result.status).toBe('completed')
    expect(result.data).toMatchObject({ decompiledFunctionCount: 1, returnedFunctionCount: 1, visitedFunctionCount: 2, failedFunctionCount: 1, codeBytes: 64 })
    expect(result.data.observations).toMatchObject([{
      type: 'code_unit', key: expect.stringMatching(/^ghidra:function:[0-9a-f]{32}$/), label: 'main',
      attributes: { unitType: 'function', address: 'ram:00401000', language: 'C', sizeBytes: 32, decompiled: true },
    }])
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('http://ghidra-analyzer:8011/analyze', expect.objectContaining({ method: 'POST' }))
  })

  it('returns analyzer errors as failed tasks', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'unsupported file' }), { status: 422 }))
    const result = await executeGhidra(input)
    expect(result.status).toBe('failed')
    expect(result.error).toBe('unsupported file')
  })
})

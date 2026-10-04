/** @vitest-environment node */
import { describe, expect, test, vi } from 'vitest'
import { executeIlspy } from './ilspy'

const input = {
  targetProfile: { targetType: 'FILE' as const, format: 'pe-dotnet', mimeType: 'application/vnd.microsoft.portable-executable', extension: 'dll', architecture: null, platform: 'windows', runtimes: ['dotnet'], embeddedArtifacts: [], entropy: null, metadata: {} },
  artifactId: 'artifact-1', projectId: 'project-1', taskId: 'task-1', runToken: 'run-1',
  artifactPath: '/data/reamon-artifacts/project-1/import-1/artifact-1', options: {},
}

function resultBody() {
  return {
    status: 'completed', toolVersion: '11.1.0.9782', classCount: 1, returnedUnits: 1, codeBytes: 4096, truncated: false,
    units: [{ name: 'Example.Library.Main', relativePath: 'Example/Library/Main.cs', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/Example/Library/Main.cs', unitType: 'type', language: 'C#', sizeBytes: 4096 }],
  }
}

describe('ILSpy process provider', () => {
  test('returns C# type observations linked to isolated decompiler output', async () => {
    vi.stubEnv('REAMON_ILSPY_URL', 'http://ilspy-analyzer:8013')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(resultBody()), { status: 200 })))

    const result = await executeIlspy(input)

    expect(result).toMatchObject({ status: 'completed', toolId: 'reamon-ilspy', data: { decompiledClassCount: 1, returnedClassCount: 1, codeBytes: 4096, ilspyVersion: '11.1.0.9782' } })
    expect(result.data.observations).toEqual([expect.objectContaining({
      type: 'code_unit', key: expect.stringMatching(/^ilspy:type:[0-9a-f]{32}$/), label: 'Example.Library.Main',
      attributes: expect.objectContaining({ unitType: 'type', language: 'C#', sizeBytes: 4096, decompiled: true }),
    })])
    expect(fetch).toHaveBeenCalledWith('http://ilspy-analyzer:8013/analyze', expect.objectContaining({ method: 'POST' }))
  })

  test('keeps the index percentage unknown when ILSpy hits its source scan bound', async () => {
    vi.stubEnv('REAMON_ILSPY_URL', 'http://ilspy-analyzer:8013')
    const body = { ...resultBody(), classCount: null, truncated: true, warnings: 'More than 10,000 files were produced.' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })))

    const result = await executeIlspy(input)

    expect(result).toMatchObject({ status: 'completed', data: { decompiledClassCount: null, truncated: true } })
  })

  test('reports an unavailable isolated service instead of claiming success', async () => {
    vi.stubEnv('REAMON_ILSPY_URL', '')

    const result = await executeIlspy(input)

    expect(result).toMatchObject({ status: 'failed', error: 'The isolated ILSpy analyzer is not configured' })
  })
})

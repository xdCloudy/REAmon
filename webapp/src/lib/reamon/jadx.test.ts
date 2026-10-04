import { describe, expect, test, vi } from 'vitest'
import { executeJadx } from './jadx'
import { canonicalKeyForObservation } from './result-ingestion'

const input = {
  targetProfile: { targetType: 'FILE' as const, format: 'apk', mimeType: 'application/vnd.android.package-archive', extension: 'apk', architecture: null, platform: 'android', runtimes: [], embeddedArtifacts: [], entropy: null, metadata: {} },
  artifactId: 'artifact-1', projectId: 'project-1', taskId: 'task-1', runToken: 'run-1',
  artifactPath: '/data/reamon-artifacts/project-1/import-1/artifact-1', options: {},
}

function resultBody() {
  return {
    status: 'completed', toolVersion: '1.5.6', classCount: 1, returnedUnits: 1, truncated: false,
    units: [{ name: 'com.example.MainActivity', relativePath: 'com/example/MainActivity.java', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/com/example/MainActivity.java', sizeBytes: 4096 }],
  }
}

describe('JADX process provider', () => {
  test('returns size-described code units linked to the isolated analyzer output', async () => {
    vi.stubEnv('REAMON_JADX_URL', 'http://jadx-analyzer:8010')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(resultBody()), { status: 200 })))

    const result = await executeJadx(input)

    expect(result).toMatchObject({ status: 'completed', toolId: 'reamon-jadx', data: { decompiledClassCount: 1, returnedClassCount: 1, codeBytes: 4096 } })
    expect(result.data.observations).toEqual([expect.objectContaining({
      type: 'code_unit', key: expect.stringMatching(/^jadx:class:[0-9a-f]{32}$/), label: 'com.example.MainActivity',
      attributes: expect.objectContaining({ unitType: 'class', language: 'Java', sizeBytes: 4096, decompiled: true }),
    })])
    expect(fetch).toHaveBeenCalledWith('http://jadx-analyzer:8010/analyze', expect.objectContaining({ method: 'POST' }))
  })

  test('retains separate run observations while preserving graph identity', async () => {
    vi.stubEnv('REAMON_JADX_URL', 'http://jadx-analyzer:8010')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(resultBody()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await executeJadx(input)
    const second = await executeJadx({ ...input, taskId: 'task-2', runToken: 'run-2' })
    const firstUnit = first.data.observations?.[0]
    const secondUnit = second.data.observations?.[0]

    expect(firstUnit?.key).not.toBe(secondUnit?.key)
    expect(firstUnit && secondUnit && canonicalKeyForObservation('reamon-jadx', firstUnit))
      .toBe(firstUnit && secondUnit && canonicalKeyForObservation('reamon-jadx', secondUnit))
  })

  test('accepts a profiled Java archive and uses the same isolated JADX service', async () => {
    vi.stubEnv('REAMON_JADX_URL', 'http://jadx-analyzer:8010')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(resultBody()), { status: 200 })))

    const result = await executeJadx({
      ...input,
      targetProfile: { ...input.targetProfile, format: 'jar', extension: 'jar', platform: 'jvm', runtimes: ['jvm'] },
    })

    expect(result).toMatchObject({ status: 'completed', toolId: 'reamon-jadx', data: { decompiledClassCount: 1 } })
    expect(fetch).toHaveBeenCalledWith('http://jadx-analyzer:8010/analyze', expect.objectContaining({ method: 'POST' }))
  })

  test.each([
    { format: 'dex', extension: 'dex', platform: 'android', runtimes: ['dalvik', 'art'] },
    { format: 'class', extension: 'class', platform: 'jvm', runtimes: ['jvm'] },
  ])('accepts standalone $format bytecode with the isolated JADX service', async (profile) => {
    vi.stubEnv('REAMON_JADX_URL', 'http://jadx-analyzer:8010')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(resultBody()), { status: 200 })))

    const result = await executeJadx({
      ...input,
      targetProfile: { ...input.targetProfile, ...profile },
    })

    expect(result).toMatchObject({ status: 'completed', toolId: 'reamon-jadx', data: { decompiledClassCount: 1 } })
    expect(fetch).toHaveBeenCalledWith('http://jadx-analyzer:8010/analyze', expect.objectContaining({ method: 'POST' }))
  })

  test('reports a missing analyzer instead of advertising a false success', async () => {

    vi.stubEnv('REAMON_JADX_URL', '')

    const result = await executeJadx(input)

    expect(result).toMatchObject({ status: 'failed', error: 'The isolated JADX analyzer is not configured' })
  })
})

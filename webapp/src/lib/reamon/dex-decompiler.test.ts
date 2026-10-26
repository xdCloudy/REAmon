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
  })

  it('rejects malformed failed-class identities from the analyzer', async () => {
    const details = [{ dexEntry: 'classes2.dex', classIndex: -1, descriptor: 'Lcom/example/Broken;', reason: 'failed' }]
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(responseBody(details)), { status: 200 }))

    const result = await executeDexDecompiler(input)

    expect(result).toMatchObject({ status: 'failed', error: 'DEX decompiler returned an invalid result' })
  })
})

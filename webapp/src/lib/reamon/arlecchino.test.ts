/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeArlecchino } from './arlecchino'

const input = {
  targetProfile: { targetType: 'FILE' as const, format: 'jar', mimeType: 'application/java-archive', extension: 'jar', architecture: null, platform: 'jvm', runtimes: ['java'], embeddedArtifacts: [], entropy: null, metadata: {} },
  artifactId: 'artifact-1', projectId: 'project-1', taskId: 'task-1', runToken: 'run-1', artifactPath: '/data/reamon-artifacts/project-1/app.jar',
}

describe('Arlecchino provider lineage', () => {
  beforeEach(() => {
    vi.stubEnv('REAMON_ARLECCHINO_URL', 'http://arlecchino-analyzer:8012')
    vi.stubGlobal('fetch', vi.fn())
  })

  it('persists the composite engines and selection policy on each recovered unit', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', toolVersion: '1.0.0', providerRevision: 'a'.repeat(40), inputName: 'app.jar',
      artifactSha256: 'b'.repeat(64), sourceFileCount: 1, codeBytes: 42, truncated: false,
      engineRanking: [{ engine: 'vineflower', classes: 1, errors: 0 }, { engine: 'cfr', classes: 1, errors: 0 }],
      bestBaseEngine: 'vineflower', mergedCompilerErrorCount: 0, memberRenamesApplied: false,
      renameMapping: null, roundTrip: null, analysisArtifactId: 'project-1/artifact-1/task-1/run-1/analysis.json',
      units: [{ name: 'Main', relativePath: 'com/example/Main.java', codeArtifactId: 'project-1/artifact-1/task-1/run-1/merged/com/example/Main.java', language: 'Java', sizeBytes: 42, outputSha256: 'c'.repeat(64) }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const result = await executeArlecchino(input)
    const observations = result.data.observations as Array<{ type: string; attributes: Record<string, unknown> }>
    const unit = observations.find((observation) => observation.type === 'code_unit')

    expect(result.status).toBe('completed')
    expect(unit?.attributes).toMatchObject({
      providerLineageKind: 'derived-composite',
      providerUpstreamProviderIds: 'reamon-vineflower,reamon-cfr,reamon-jadx',
      providerSelectionPolicy: 'per-class compiler-error ranking and source merge',
    })
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('http://arlecchino-analyzer:8012/analyze', expect.objectContaining({ method: 'POST' }))
  })
})

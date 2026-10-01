import { describe, expect, test } from 'vitest'
import { buildWorkspaceProfile, isLogicalTargetCandidate } from './inventory'
import type { TargetProfile } from './types'

function profile(format: string, extension = '', platform: string | null = null): TargetProfile {
  return {
    targetType: 'FILE', format, mimeType: 'application/octet-stream', extension,
    architecture: null, platform, runtimes: [], embeddedArtifacts: [], entropy: null,
    metadata: {},
  }
}

describe('workspace inventory profiling', () => {
  test('keeps duplicate content at distinct paths while aggregating deterministically', () => {
    const artifacts = [
      { relativePath: 'bin/x64/foo.dll', sizeBytes: 10, profile: profile('pe-dll', 'dll', 'windows') },
      { relativePath: 'bin/x86/foo.dll', sizeBytes: 10, profile: profile('pe-dll', 'dll', 'windows') },
      { relativePath: 'src/main.ts', sizeBytes: 20, profile: profile('source', 'ts') },
      { relativePath: 'config/settings.json', sizeBytes: 5, profile: profile('source', 'json') },
    ]
    const result = buildWorkspaceProfile(artifacts)
    expect(result.fileCount).toBe(4)
    expect(result.directoryCount).toBe(5)
    expect(result.totalBytes).toBe(45)
    expect(result.detectedPlatforms).toEqual(['windows'])
    expect(result.sourceFileCount).toBe(2)
    expect(result.configurationFileCount).toBe(1)
    expect(result.interestingArtifacts).toBe(2)
    expect(result.potentialEntrypoints).toEqual([])
  })

  test('identifies binary candidates without treating every file as a target', () => {
    expect(isLogicalTargetCandidate({ relativePath: 'app.exe', sizeBytes: 1, profile: profile('unknown', 'exe') })).toBe(true)
    expect(isLogicalTargetCandidate({ relativePath: 'assets/icon.png', sizeBytes: 1, profile: profile('unknown', 'png') })).toBe(false)
  })
})

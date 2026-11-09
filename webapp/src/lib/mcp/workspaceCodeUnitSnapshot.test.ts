import { describe, expect, test } from 'vitest'
import { hashWorkspaceCodeUnitSourceSnapshot, type WorkspaceCodeUnitSourceSnapshot } from './workspaceCodeUnitSnapshot'

const snapshot: WorkspaceCodeUnitSourceSnapshot = {
  codeUnitId: 'unit-1',
  artifactId: 'artifact-1',
  artifactSha256: 'a'.repeat(64),
  decompiledSourceSha256: 'b'.repeat(64),
  disassemblySha256: 'c'.repeat(64),
  maintainedSourceSha256: 'd'.repeat(64),
  savedDraftSha256: 'e'.repeat(64),
}

describe('workspace code-unit source snapshot hash', () => {
  test('is stable for an unchanged unit and artifact source set', () => {
    expect(hashWorkspaceCodeUnitSourceSnapshot(snapshot)).toBe(hashWorkspaceCodeUnitSourceSnapshot({ ...snapshot }))
  })

  test('changes when any pageable source version changes', () => {
    for (const key of ['decompiledSourceSha256', 'disassemblySha256', 'maintainedSourceSha256', 'savedDraftSha256'] as const) {
      expect(hashWorkspaceCodeUnitSourceSnapshot({ ...snapshot, [key]: 'f'.repeat(64) })).not.toBe(hashWorkspaceCodeUnitSourceSnapshot(snapshot))
    }
  })
})

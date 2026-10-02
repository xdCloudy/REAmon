import { describe, expect, test } from 'vitest'
import { activeWorkspaceImportIds, activeWorkspaceTargetIds, compareWorkspaceImports } from './imports'

describe('workspace import comparisons', () => {
  test('selects the latest completed snapshot without deleting history', () => {
    const active = activeWorkspaceImportIds([
      { id: 'new-partial', rootName: 'ExampleApp', status: 'UPLOADING', createdAt: '2026-10-01T12:00:00Z' },
      { id: 'old-complete', rootName: 'ExampleApp', status: 'COMPLETED', createdAt: '2026-10-01T11:00:00Z' },
      { id: 'other-root', rootName: 'Firmware', status: 'CANCELLED', createdAt: '2026-10-01T10:00:00Z' },
    ])

    expect([...active]).toEqual(['old-complete', 'other-root'])
  })

  test('shows a partial snapshot when no completed snapshot exists', () => {
    const active = activeWorkspaceImportIds([
      { id: 'old-cancelled', rootName: 'ExampleApp', status: 'CANCELLED', createdAt: '2026-10-01T11:00:00Z' },
      { id: 'new-pending', rootName: 'ExampleApp', status: 'PENDING', createdAt: '2026-10-01T12:00:00Z' },
    ])

    expect([...active]).toEqual(['new-pending'])
  })

  test('keeps active imported targets and legacy targets without duplicating history', () => {
    const visible = activeWorkspaceTargetIds([
      { id: 'active-root', targetType: 'DIRECTORY', parentTargetId: null },
      { id: 'active-binary', targetType: 'FILE', parentTargetId: 'active-root' },
      { id: 'old-binary', targetType: 'FILE', parentTargetId: 'old-root' },
      { id: 'old-root', targetType: 'DIRECTORY', parentTargetId: null },
      { id: 'legacy-target', targetType: 'REMOTE_HOST', parentTargetId: null },
    ], new Set(['active-root']), new Set(['active-binary']), true)

    expect([...visible]).toEqual(['active-root', 'active-binary', 'legacy-target'])
  })

  test('classifies added, changed, removed, and unchanged paths', () => {
    const comparison = compareWorkspaceImports(
      [
        { relativePath: 'same.bin', size: 2, sha256: 'same' },
        { relativePath: 'changed.bin', size: 2, sha256: 'old' },
        { relativePath: 'removed.bin', size: 2, sha256: 'removed' },
      ],
      [
        { relativePath: 'same.bin', size: 2, sha256: 'same' },
        { relativePath: 'changed.bin', size: 3, sha256: 'new' },
        { relativePath: 'added.bin', size: 1, sha256: 'added' },
      ],
      { mode: 'HASH', previousImportId: 'previous-1' },
    )

    expect(comparison).toMatchObject({
      mode: 'HASH',
      previousImportId: 'previous-1',
      addedCount: 1,
      changedCount: 1,
      removedCount: 1,
      unchangedCount: 1,
      addedPaths: ['added.bin'],
      changedPaths: ['changed.bin'],
      removedPaths: ['removed.bin'],
      unchangedPaths: ['same.bin'],
    })
  })

  test('uses size and modification time for manifest preflight', () => {
    const comparison = compareWorkspaceImports(
      [{ relativePath: 'config.json', size: 10, lastModified: 1 }],
      [{ relativePath: 'config.json', size: 10, lastModified: 2 }],
      { mode: 'MANIFEST' },
    )

    expect(comparison.changedCount).toBe(1)
    expect(comparison.previousImportId).toBeNull()
  })

  test('caps path samples while preserving deterministic counts', () => {
    const previous = Array.from({ length: 250 }, (_, index) => ({ relativePath: `file-${index}.bin`, size: 1, sha256: 'old' }))
    const current = previous.map((entry) => ({ ...entry, sha256: 'new' }))
    const comparison = compareWorkspaceImports(previous, current, { mode: 'HASH' })

    expect(comparison.changedCount).toBe(250)
    expect(comparison.changedPaths).toHaveLength(200)
    expect(comparison.changedPaths[0]).toBe('file-0.bin')
  })
})

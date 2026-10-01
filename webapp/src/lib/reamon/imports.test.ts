import { describe, expect, test } from 'vitest'
import { compareWorkspaceImports } from './imports'

describe('workspace import comparisons', () => {
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

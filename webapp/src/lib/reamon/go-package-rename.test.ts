import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  buildGoPackageRenameSnapshot,
  hashGoPackageSourceSet,
  GoPackageRenameSnapshotError,
  isSafeGoPackagePath,
  type GoPackageAcceptedSource,
  type GoPackageRenameUnit,
  type GoPackageReviewReceipt,
} from './go-package-rename'

const selectedSource = 'package sample\nfunc run() {}\n'
const siblingSource = 'package sample\nfunc normalize(value int) int { return value }\n'
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

describe('hashGoPackageSourceSet', () => {
  it('matches the path and source-hash contract independent of input order', () => {
    const files = [
      { relativePath: 'pkg/b.go', sourceHash: hash(siblingSource) },
      { relativePath: 'pkg/a.go', sourceHash: hash(selectedSource) },
    ]
    const expected = createHash('sha256')
      .update(`pkg/a.go\0${hash(selectedSource)}\npkg/b.go\0${hash(siblingSource)}\n`)
      .digest('hex')

    expect(hashGoPackageSourceSet(files)).toBe(expected)
    expect(hashGoPackageSourceSet([...files].reverse())).toBe(expected)
    expect(hashGoPackageSourceSet([{ ...files[0], sourceHash: 'a'.repeat(64) }, files[1]])).not.toBe(expected)
  })
})

const units: GoPackageRenameUnit[] = [
  { unitId: 'selected', unitName: 'pkg/a.go', relativePath: 'pkg/a.go' },
  { unitId: 'sibling', unitName: 'pkg/b.go', relativePath: 'pkg/b.go' },
  { unitId: 'other', unitName: 'other/c.go', relativePath: 'other/c.go' },
]
const acceptedSources: GoPackageAcceptedSource[] = [{
  codeUnitId: 'sibling', relativePath: 'pkg/b.go', sourceCode: siblingSource,
  sourceHash: hash(siblingSource), acceptedReviewId: 'review-sibling',
}]
const reviews: GoPackageReviewReceipt[] = [{
  id: 'review-sibling', codeUnitId: 'sibling', maintainedSourceHash: hash(siblingSource), decision: 'ACCEPTED',
}]

describe('buildGoPackageRenameSnapshot', () => {
  it('uses the current selected file and only accepted same-directory sibling sources', () => {
    const result = buildGoPackageRenameSnapshot({
      selectedUnitId: 'selected', selectedPath: 'pkg/a.go', selectedSource,
      units, acceptedSources, reviews,
    })

    expect(result).toEqual([
      expect.objectContaining({ codeUnitId: 'selected', relativePath: 'pkg/a.go', sourceCode: selectedSource, acceptedReviewId: null, sourceHash: hash(selectedSource) }),
      expect.objectContaining({ codeUnitId: 'sibling', relativePath: 'pkg/b.go', sourceCode: siblingSource, acceptedReviewId: 'review-sibling', sourceHash: hash(siblingSource) }),
    ])
  })

  it('rejects missing and stale sibling review evidence', () => {
    expect(() => buildGoPackageRenameSnapshot({
      selectedUnitId: 'selected', selectedPath: 'pkg/a.go', selectedSource, units, acceptedSources: [], reviews,
    })).toThrow(/not backed by a current accepted review receipt/)

    expect(() => buildGoPackageRenameSnapshot({
      selectedUnitId: 'selected', selectedPath: 'pkg/a.go', selectedSource, units,
      acceptedSources: [{ ...acceptedSources[0], sourceHash: '0'.repeat(64) }], reviews,
    })).toThrow(/not backed by a current accepted review receipt/)
  })

  it('rejects an incomplete or colliding package snapshot', () => {
    expect(() => buildGoPackageRenameSnapshot({
      selectedUnitId: 'selected', selectedPath: 'pkg/a.go', selectedSource,
      units: [units[0]], acceptedSources, reviews,
    })).toThrow(GoPackageRenameSnapshotError)

    expect(() => buildGoPackageRenameSnapshot({
      selectedUnitId: 'selected', selectedPath: 'pkg/a.go', selectedSource,
      units: [units[0], { ...units[1], relativePath: 'pkg/A.go' }], acceptedSources, reviews,
    })).toThrow(/colliding paths/)
  })

  it('rejects unsafe paths and oversized file contents', () => {
    expect(isSafeGoPackagePath('../pkg/a.go')).toBe(false)
    expect(isSafeGoPackagePath('pkg\\a.go')).toBe(false)
    expect(isSafeGoPackagePath('pkg/a.go')).toBe(true)
    expect(() => buildGoPackageRenameSnapshot({
      selectedUnitId: 'selected', selectedPath: 'pkg/a.go', selectedSource: 'x'.repeat(512 * 1024 + 1),
      units, acceptedSources, reviews,
    })).toThrow(/512 KiB/)
  })
})

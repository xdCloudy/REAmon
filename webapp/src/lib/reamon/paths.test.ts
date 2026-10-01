import { describe, expect, test } from 'vitest'
import { InvalidWorkspacePathError, normalizeRelativePath, parentPathOf } from './paths'

describe('workspace logical paths', () => {
  test.each([
    ['foo/bar.dll', 'foo/bar.dll'],
    ['foo\\bar.dll', 'foo/bar.dll'],
    ['./foo/./bar.dll', 'foo/bar.dll'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeRelativePath(input)).toBe(expected)
  })

  test.each(['../bar.dll', '../../etc/passwd', '/absolute/path', 'C:\\Windows\\system32', 'foo/../../../bar', ''])('rejects hostile path %s', (input) => {
    expect(() => normalizeRelativePath(input)).toThrow(InvalidWorkspacePathError)
  })

  test('derives a logical parent path', () => {
    expect(parentPathOf('bin/x64/foo.dll')).toBe('bin/x64')
    expect(parentPathOf('foo.dll')).toBe('')
  })
})

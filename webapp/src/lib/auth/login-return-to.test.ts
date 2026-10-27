import { describe, expect, test } from 'vitest'
import { safeLoginDestination } from './login-return-to'

describe('safeLoginDestination', () => {
  const origin = 'http://reamon.local'

  test('preserves an internal destination, query, and fragment', () => {
    expect(safeLoginDestination('/projects/new?kind=reverse#source', origin))
      .toBe('/projects/new?kind=reverse#source')
  })

  test.each([
    null,
    undefined,
    '',
    'projects/new',
    '//attacker.example/path',
    'https://attacker.example/path',
    '/\\attacker.example/path',
    '/login?next=/projects/new',
    '/login/',
    '/api/auth/login',
  ])('falls back for an unsafe or missing return path: %s', (returnTo) => {
    expect(safeLoginDestination(returnTo, origin)).toBe('/projects')
  })
})

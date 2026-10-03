/** @vitest-environment node */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { boundResultData } from './result-bounds'

afterEach(() => vi.unstubAllEnvs())

describe('provider result persistence bounds', () => {
  test('preserves JSON payloads beneath the configured limit', () => {
    vi.stubEnv('REAMON_MAX_RESULT_BYTES', '65536')

    expect(boundResultData({ strings: ['hello'], nested: { enabled: true } })).toEqual({
      strings: ['hello'],
      nested: { enabled: true },
    })
  })

  test('replaces oversized payloads with a bounded diagnostic marker', () => {
    vi.stubEnv('REAMON_MAX_RESULT_BYTES', '65536')

    const result = boundResultData({ output: 'x'.repeat(100_000) })

    expect(result).toEqual({ _reamonTruncated: true, originalBytes: 100_013, maxBytes: 65_536, reason: 'size' })
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(65_536)
  })

  test('clamps an unsafe configured limit and rejects non-JSON values safely', () => {
    vi.stubEnv('REAMON_MAX_RESULT_BYTES', '1')

    expect(boundResultData({ value: BigInt(1) })).toEqual({
      _reamonTruncated: true,
      originalBytes: null,
      maxBytes: 65_536,
      reason: 'non_json',
    })
  })
})

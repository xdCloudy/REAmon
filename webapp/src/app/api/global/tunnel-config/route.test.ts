/**
 * The agent needs the Chisel server URL to derive the public host. Browser
 * sessions and scanner service credentials must not receive tunnel secrets.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockFindFirst = vi.fn()

vi.mock('@/lib/prisma', () => ({
  default: {
    userSettings: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
    },
  },
}))

import { GET } from './route'

function request(internalKey?: string): NextRequest {
  return new NextRequest('http://localhost/api/global/tunnel-config', {
    headers: internalKey ? { 'x-internal-key': internalKey } : undefined,
  })
}

beforeEach(() => {
  process.env.INTERNAL_API_KEY = 'test-internal-key'
  process.env.SCANNER_API_KEY = 'test-scanner-key'
  mockFindFirst.mockReset().mockResolvedValue({
    chiselServerUrl: 'https://chisel.example.test',
  })
})

afterEach(() => {
  delete process.env.INTERNAL_API_KEY
  delete process.env.SCANNER_API_KEY
  vi.restoreAllMocks()
})

describe('GET /api/global/tunnel-config', () => {
  test('rejects callers without the internal service key', async () => {
    const response = await GET(request())

    expect(response.status).toBe(401)
    expect(mockFindFirst).not.toHaveBeenCalled()
  })

  test('rejects the scanner key', async () => {
    const response = await GET(request('test-scanner-key'))

    expect(response.status).toBe(401)
    expect(mockFindFirst).not.toHaveBeenCalled()
  })

  test('returns only the Chisel URL to the internal agent', async () => {
    const response = await GET(request('test-internal-key'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ chiselServerUrl: 'https://chisel.example.test' })
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { chiselServerUrl: { not: '' } },
      select: { chiselServerUrl: true },
    })
  })

  test('strips credentials and request paths from the Chisel URL', async () => {
    mockFindFirst.mockResolvedValue({
      chiselServerUrl: 'https://operator:secret@chisel.example.test:8443/tunnel?token=hidden',
    })

    const response = await GET(request('test-internal-key'))

    expect(await response.json()).toEqual({ chiselServerUrl: 'https://chisel.example.test:8443' })
  })

  test('returns an empty URL when no Chisel setting is available', async () => {
    mockFindFirst.mockResolvedValue(null)

    const response = await GET(request('test-internal-key'))

    expect(await response.json()).toEqual({ chiselServerUrl: '' })
  })
})

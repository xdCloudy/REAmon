/** @vitest-environment node */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mockGuardProject = vi.fn()
vi.mock('@/lib/access', () => ({ guardProject: (...a: unknown[]) => mockGuardProject(...a) }))

import { GET } from './route'

let fetchCalls: string[]
let fetchInits: (RequestInit | undefined)[]
const NOT_FOUND = NextResponse.json({ error: 'Not found' }, { status: 404 })

beforeEach(() => {
  fetchCalls = []
  fetchInits = []
  mockGuardProject.mockReset()
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    fetchCalls.push(String(url))
    fetchInits.push(init)
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(3), headers: new Headers() } as unknown as Response
  }))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/agent/files', () => {
  test('requires project identity before accessing any agent file', async () => {
    const res = await GET(new NextRequest('http://x/api/agent/files?path=/tmp/out.txt'))
    expect(res.status).toBe(400)
    expect(mockGuardProject).not.toHaveBeenCalled()
    expect(fetchCalls).toHaveLength(0)
  })

  test('with projectId, owner → guard passes and proxies only to workspace/download', async () => {
    mockGuardProject.mockResolvedValue(null)
    const res = await GET(new NextRequest('http://x/api/agent/files?projectId=p1&path=tool-outputs%2Fout.txt'))
    expect(res.status).toBe(200)
    expect(mockGuardProject).toHaveBeenCalledWith('p1')
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]).toContain('/workspace/download?projectId=p1&path=tool-outputs%2Fout.txt')
    expect(fetchCalls[0]).not.toContain('/files?path=')
  })

  test('EXPLOIT: with projectId, cross-user → 404, no proxy', async () => {
    mockGuardProject.mockResolvedValue(NOT_FOUND)
    const res = await GET(new NextRequest('http://x/api/agent/files?projectId=victimProj&path=/a'))
    expect(res.status).toBe(404)
    expect(fetchCalls).toHaveLength(0)
  })

  test('forwards the internal API key to the project workspace endpoint', async () => {
    vi.stubEnv('INTERNAL_API_KEY', 'test-key-123')
    mockGuardProject.mockResolvedValue(null)
    const res = await GET(new NextRequest('http://x/api/agent/files?projectId=p1&path=tool-outputs%2Fout.txt'))
    expect(res.status).toBe(200)
    const headers = (fetchInits[0]?.headers ?? {}) as Record<string, string>
    expect(headers['x-internal-key']).toBe('test-key-123')
  })
})

/**
 * Stored-XSS hardening — GET /api/projects/[id]/reports/[reportId].
 *
 * Report HTML embeds target-influenced strings and is served inline, so the
 * response must block MIME sniffing and neutralize script execution with a
 * restrictive CSP.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mockRequireEffectiveUser = vi.fn()
const mockRequireProjectAccessStrict = vi.fn()
const mockReportFindFirst = vi.fn()
const mockExistsSync = vi.fn()
const mockReadFileSync = vi.fn()

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: (...a: unknown[]) => mockRequireEffectiveUser(...a),
  requireProjectAccessStrict: (...a: unknown[]) => mockRequireProjectAccessStrict(...a),
}))
vi.mock('@/lib/prisma', () => ({
  default: { report: { findFirst: (...a: unknown[]) => mockReportFindFirst(...a), delete: vi.fn() } },
}))
vi.mock('fs', () => ({
  existsSync: (...a: unknown[]) => mockExistsSync(...a),
  readFileSync: (...a: unknown[]) => mockReadFileSync(...a),
  unlinkSync: vi.fn(),
}))

import { DELETE, GET } from './route'

const params = (id: string, reportId: string) => ({ params: Promise.resolve({ id, reportId }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireEffectiveUser.mockResolvedValue({ userId: 'u1', role: 'user' })
  mockRequireProjectAccessStrict.mockResolvedValue(null) // allowed
  mockReportFindFirst.mockResolvedValue({
    id: 'r1', projectId: 'p1', filePath: '/data/reports/r.html', filename: 'r.html',
  })
  mockExistsSync.mockReturnValue(true)
  mockReadFileSync.mockReturnValue(Buffer.from('<html><body>report</body></html>'))
})

describe('GET report — security headers', () => {
  test('serves the report with nosniff and a script-blocking CSP', async () => {
    const res = await GET(new NextRequest('http://x'), params('p1', 'r1'))
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const csp = res.headers.get('Content-Security-Policy') || ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    // no 'script-src' allowance -> scripts fall back to default-src 'none'
    expect(csp).not.toMatch(/script-src\s+[^;]*'unsafe-inline'/)
  })

  test('still enforces project ownership before serving', async () => {
    mockRequireProjectAccessStrict.mockResolvedValue(NextResponse.json({ error: 'not found' }, { status: 404 }))
    const res = await GET(new NextRequest('http://x'), params('p1', 'r1'))
    expect(res.status).toBe(404)
    expect(mockReadFileSync).not.toHaveBeenCalled()
  })

  test('strict ownership denial also prevents report deletion', async () => {
    mockRequireProjectAccessStrict.mockResolvedValue(NextResponse.json({ error: 'not found' }, { status: 404 }))

    const res = await DELETE(new NextRequest('http://x'), params('p1', 'r1'))

    expect(res.status).toBe(404)
    expect(mockReportFindFirst).not.toHaveBeenCalled()
    expect(mockExistsSync).not.toHaveBeenCalled()
  })
})

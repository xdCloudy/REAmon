/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  guardProjectStrict: vi.fn(),
  projectFindUnique: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  guardProjectStrict: (...args: unknown[]) => h.guardProjectStrict(...args),
}))
vi.mock('@/lib/prisma', () => ({
  default: { project: { findUnique: (...args: unknown[]) => h.projectFindUnique(...args) } },
}))

import { GET } from './route'

const request = new NextRequest('http://test/api/projects/p1/roe/download')
const params = { params: Promise.resolve({ id: 'p1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  h.guardProjectStrict.mockResolvedValue(null)
  h.projectFindUnique.mockResolvedValue({
    roeDocumentData: Buffer.from('owned engagement document'),
    roeDocumentName: 'rules.pdf',
    roeDocumentMimeType: 'application/pdf',
  })
})

describe('RoE document download ownership', () => {
  test('rejects an unauthenticated caller before reading document data', async () => {
    h.guardProjectStrict.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const response = await GET(request, params)
    expect(response.status).toBe(401)
    expect(h.projectFindUnique).not.toHaveBeenCalled()
  })

  test('rejects a different project owner before reading document data', async () => {
    h.guardProjectStrict.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
    const response = await GET(request, params)
    expect(response.status).toBe(404)
    expect(h.projectFindUnique).not.toHaveBeenCalled()
  })

  test('allows the project owner to download the original document', async () => {
    const response = await GET(request, params)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toContain('rules.pdf')
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('owned engagement document')
    expect(h.projectFindUnique).toHaveBeenCalledOnce()
  })
})

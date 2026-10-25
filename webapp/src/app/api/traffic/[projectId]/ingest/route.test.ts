/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mockProjectFindUnique = vi.fn()
const mockCreateMany = vi.fn()
const mockIsInternal = vi.fn()
const mockIsScanner = vi.fn()
const mockGetScannerScope = vi.fn()

vi.mock('@/lib/prisma', () => ({
  default: {
    project: { findUnique: (...args: unknown[]) => mockProjectFindUnique(...args) },
    capturedHttpTransaction: { createMany: (...args: unknown[]) => mockCreateMany(...args) },
  },
}))
vi.mock('@/lib/session', () => ({
  isInternalRequest: (...args: unknown[]) => mockIsInternal(...args),
  isScannerRequest: (...args: unknown[]) => mockIsScanner(...args),
  getScannerScope: (...args: unknown[]) => mockGetScannerScope(...args),
}))
vi.mock('@/lib/scaIntel', () => ({ iocColumns: () => ({ iocIncidentId: null, iocIncidentUrl: null }) }))

import { POST } from './route'

const params = { params: Promise.resolve({ projectId: 'project-1' }) }
function request() {
  return new NextRequest('http://x/api/traffic/project-1/ingest', {
    method: 'POST',
    body: JSON.stringify({ userId: 'attacker', transactions: [{ host: 'example.test' }] }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsInternal.mockReturnValue(false)
  mockIsScanner.mockReturnValue(false)
  mockGetScannerScope.mockReturnValue(null)
  mockProjectFindUnique.mockResolvedValue({ userId: 'owner', captureProxyEnabled: true })
  mockCreateMany.mockResolvedValue({ count: 1 })
})

describe('POST /api/traffic/[projectId]/ingest scanner tenant scope', () => {
  test('scanner key without a scope is denied before project lookup or writes', async () => {
    mockIsScanner.mockReturnValue(true)
    const response = await POST(request(), params)
    expect(response.status).toBe(404)
    expect(mockProjectFindUnique).not.toHaveBeenCalled()
    expect(mockCreateMany).not.toHaveBeenCalled()
  })

  test('scope for another project is denied before project lookup or writes', async () => {
    mockIsScanner.mockReturnValue(true)
    mockGetScannerScope.mockReturnValue({ projectId: 'other-project', userId: 'owner' })
    const response = await POST(request(), params)
    expect(response.status).toBe(404)
    expect(mockProjectFindUnique).not.toHaveBeenCalled()
    expect(mockCreateMany).not.toHaveBeenCalled()
  })

  test('matching project with a different database owner is denied before writes', async () => {
    mockIsScanner.mockReturnValue(true)
    mockGetScannerScope.mockReturnValue({ projectId: 'project-1', userId: 'attacker' })
    const response = await POST(request(), params)
    expect(response.status).toBe(404)
    expect(mockCreateMany).not.toHaveBeenCalled()
  })

  test('valid scope writes under the database owner, ignoring body tenant fields', async () => {
    mockIsScanner.mockReturnValue(true)
    mockGetScannerScope.mockReturnValue({ projectId: 'project-1', userId: 'owner' })
    const response = await POST(request(), params)
    expect(response.status).toBe(201)
    expect(mockCreateMany.mock.calls[0][0].data[0]).toMatchObject({ projectId: 'project-1', userId: 'owner' })
  })
})

/**
 * /api/projects/[id]/authorizations: immutable authorization evidence is owner-only.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mockProjectFindUnique = vi.fn()
const mockAuthorizationFindMany = vi.fn()
const mockRequireEffectiveUser = vi.fn()

vi.mock('@/lib/prisma', () => ({
  default: {
    project: { findUnique: (...args: unknown[]) => mockProjectFindUnique(...args) },
    engagementAuthorization: { findMany: (...args: unknown[]) => mockAuthorizationFindMany(...args) },
  },
}))
vi.mock('@/lib/access', async () => {
  const actual = await vi.importActual<typeof import('@/lib/access')>('@/lib/access')
  return { ...actual, requireEffectiveUser: () => mockRequireEffectiveUser() }
})

import { GET } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.ACCESS_ENFORCE
  mockRequireEffectiveUser.mockResolvedValue({ userId: 'owner' })
  mockProjectFindUnique.mockResolvedValue({ id: 'project-1', userId: 'owner' })
  mockAuthorizationFindMany.mockResolvedValue([])
})

describe('GET authorization boundary', () => {
  test('anonymous caller receives 401 before listing records', async () => {
    mockRequireEffectiveUser.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))

    expect((await GET(new NextRequest('http://x'), params)).status).toBe(401)
    expect(mockProjectFindUnique).not.toHaveBeenCalled()
    expect(mockAuthorizationFindMany).not.toHaveBeenCalled()
  })

  test('foreign owner receives 404 before listing records even when enforcement is disabled', async () => {
    process.env.ACCESS_ENFORCE = '0'
    mockRequireEffectiveUser.mockResolvedValue({ userId: 'foreign' })

    expect((await GET(new NextRequest('http://x'), params)).status).toBe(404)
    expect(mockAuthorizationFindMany).not.toHaveBeenCalled()
  })

  test('project owner can read the authorization records', async () => {
    mockAuthorizationFindMany.mockResolvedValue([{ id: 'authorization-1', summary: 'synthetic scope' }])

    const response = await GET(new NextRequest('http://x'), params)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authorizations: [{ id: 'authorization-1', summary: 'synthetic scope' }],
    })
    expect(mockAuthorizationFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'project-1' },
    }))
  })
})

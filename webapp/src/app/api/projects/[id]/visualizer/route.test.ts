/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  count: vi.fn(),
  getActiveWorkspaceImportSelection: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: { reamonObservation: { findMany: mocks.findMany, count: mocks.count } } }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: mocks.getActiveWorkspaceImportSelection }))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

import { GET } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.getActiveWorkspaceImportSelection.mockResolvedValue({ artifactWhere: { projectId: 'project-1', importId: { in: ['active-import'] } } })
  mocks.findMany.mockResolvedValue([])
  mocks.count.mockResolvedValue(0)
})

describe('GET /api/projects/[id]/visualizer', () => {
  test('requires an authenticated user before reading code units', async () => {
    mocks.requireEffectiveUser.mockResolvedValue(NextResponse.json({ error: 'unauthorized' }, { status: 401 }))

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer'), params)

    expect(response.status).toBe(401)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  test('returns normalized units from active workspace artifacts only', async () => {
    mocks.findMany.mockResolvedValue([{
      id: 'observation-1', stableKey: 'function:0x401000', label: 'main', source: 'ghidra', artifactId: 'artifact-1',
      updatedAt: new Date('2026-10-04T00:00:00.000Z'),
      attributes: { unitType: 'function', qualifiedName: 'app.main', address: '0x401000', sizeBytes: 256, coveragePercent: 70, language: 'C' },
      artifact: { relativePath: 'bin/app.exe', originalName: 'app.exe' },
    }])
    mocks.count.mockResolvedValue(1)

    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer'), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      total: 1,
      hasMore: false,
      units: [{ id: 'observation-1', name: 'app.main', address: '0x401000', sizeBytes: 256, coveragePercent: 70, artifactPath: 'bin/app.exe' }],
    })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'project-1', type: 'code_unit', artifact: { is: { projectId: 'project-1', importId: { in: ['active-import'] } } } },
      take: 5001,
    }))
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({ user: vi.fn(), access: vi.fn(), selection: vi.fn(), observationFindFirst: vi.fn(), observationUpsert: vi.fn(), observationDeleteMany: vi.fn(), artifactFindFirst: vi.fn() }))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: h.user,
  requireProjectAccessStrict: h.access,
}))
vi.mock('@/lib/prisma', () => ({ default: {
  reamonObservation: { findFirst: h.observationFindFirst, upsert: h.observationUpsert, deleteMany: h.observationDeleteMany },
  artifact: { findFirst: h.artifactFindFirst },
} }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))

import { GET, PUT } from './route'

describe('visualizer code-unit notes ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.user.mockResolvedValue({ userId: 'foreign-user' })
    h.access.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
  })

  it('denies foreign reads and note writes before unit lookup or note persistence', async () => {
    const params = { params: Promise.resolve({ id: 'project-1', unitId: 'unit-1' }) }
    const responses = await Promise.all([
      GET(new Request('http://localhost'), params),
      PUT(new Request('http://localhost', { method: 'PUT', body: JSON.stringify({ note: 'private note' }) }), params),
    ])

    expect(responses.map((response) => response.status)).toEqual([404, 404])
    expect(h.access).toHaveBeenCalledTimes(2)
    expect(h.access).toHaveBeenCalledWith({ userId: 'foreign-user' }, 'project-1')
    expect(h.observationFindFirst).not.toHaveBeenCalled()
    expect(h.observationUpsert).not.toHaveBeenCalled()
    expect(h.observationDeleteMany).not.toHaveBeenCalled()
    expect(h.selection).not.toHaveBeenCalled()
    expect(h.artifactFindFirst).not.toHaveBeenCalled()
  })
})

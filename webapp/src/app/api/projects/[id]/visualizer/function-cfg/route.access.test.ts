import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({ user: vi.fn(), access: vi.fn(), selection: vi.fn(), taskFindFirst: vi.fn(), observationFindFirst: vi.fn() }))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: h.user,
  requireProjectAccessStrict: h.access,
}))
vi.mock('@/lib/prisma', () => ({ default: {
  task: { findFirst: h.taskFindFirst },
  reamonObservation: { findFirst: h.observationFindFirst },
} }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))

import { GET } from './route'

describe('GET /api/projects/[id]/visualizer/function-cfg ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.user.mockResolvedValue({ userId: 'foreign-user' })
    h.access.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
  })

  it('denies foreign access before resolving active imports or reading runs and function evidence', async () => {
    const response = await GET(new Request('http://localhost/api/projects/project-1/visualizer/function-cfg?taskId=task-1&functionId=function-1'), {
      params: Promise.resolve({ id: 'project-1' }),
    })

    expect(response.status).toBe(404)
    expect(h.access).toHaveBeenCalledWith({ userId: 'foreign-user' }, 'project-1')
    expect(h.selection).not.toHaveBeenCalled()
    expect(h.taskFindFirst).not.toHaveBeenCalled()
    expect(h.observationFindFirst).not.toHaveBeenCalled()
  })
})

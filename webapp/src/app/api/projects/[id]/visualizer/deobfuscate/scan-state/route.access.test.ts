/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  user: vi.fn(),
  access: vi.fn(),
  strictAccess: vi.fn(),
  selection: vi.fn(),
  taskFindFirst: vi.fn(),
  stateFindUnique: vi.fn(),
  stateUpdateMany: vi.fn(),
  stateCreate: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: h.user,
  requireProjectAccess: h.access,
  requireProjectAccessStrict: h.strictAccess,
}))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))
vi.mock('@/lib/prisma', () => ({ default: {
  task: { findFirst: h.taskFindFirst },
  reamonFunctionQueueState: {
    findUnique: h.stateFindUnique,
    updateMany: h.stateUpdateMany,
    create: h.stateCreate,
  },
} }))

import { GET, PUT } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'foreign-user' })
  h.access.mockResolvedValue({ project: { id: 'project-1', userId: 'project-owner' } })
  h.strictAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
})

describe('deobfuscation scan-state ownership', () => {
  it.each([
    ['GET', GET, new Request('http://localhost/api/projects/project-1/visualizer/deobfuscate/scan-state?taskId=task-1')],
    ['PUT', PUT, new Request('http://localhost/api/projects/project-1/visualizer/deobfuscate/scan-state?taskId=task-1', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: {}, expectedRevision: 0 }),
    })],
  ])('%s rejects a foreign user before looking up tasks or saved checkpoints', async (_method, handler, request) => {
    const response = await handler(request, params)

    expect(response.status).toBe(404)
    expect(h.strictAccess).toHaveBeenCalledWith({ userId: 'foreign-user' }, 'project-1')
    expect(h.access).not.toHaveBeenCalled()
    expect(h.selection).not.toHaveBeenCalled()
    expect(h.taskFindFirst).not.toHaveBeenCalled()
    expect(h.stateFindUnique).not.toHaveBeenCalled()
    expect(h.stateUpdateMany).not.toHaveBeenCalled()
    expect(h.stateCreate).not.toHaveBeenCalled()
  })
})

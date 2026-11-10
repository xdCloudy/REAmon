/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  user: vi.fn(),
  access: vi.fn(),
  strictAccess: vi.fn(),
  taskFindFirst: vi.fn(),
  attemptFindFirst: vi.fn(),
  attemptFindMany: vi.fn(),
  attemptCount: vi.fn(),
  attemptUpdateMany: vi.fn(),
  leaseDeleteMany: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: h.user,
  requireProjectAccess: h.access,
  requireProjectAccessStrict: h.strictAccess,
}))
vi.mock('@/lib/prisma', () => ({ default: {
  task: { findFirst: h.taskFindFirst },
  reamonCodeAttempt: {
    findFirst: h.attemptFindFirst,
    findMany: h.attemptFindMany,
    count: h.attemptCount,
    updateMany: h.attemptUpdateMany,
  },
  reamonCodeUnitLease: { deleteMany: h.leaseDeleteMany },
} }))

import { GET as getBatches } from './batches/route'
import { POST as cancelBatch } from './batches/[batchId]/cancel/route'
import { GET as getAttempt } from './attempts/[attemptId]/route'
import { POST as cancelAttempt } from './attempts/[attemptId]/cancel/route'

beforeEach(() => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'foreign-user' })
  h.access.mockResolvedValue({ project: { id: 'project-1', userId: 'project-owner' } })
  h.strictAccess.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
})

const noProjectDataReadOrWrite = () => {
  expect(h.access).not.toHaveBeenCalled()
  expect(h.taskFindFirst).not.toHaveBeenCalled()
  expect(h.attemptFindFirst).not.toHaveBeenCalled()
  expect(h.attemptFindMany).not.toHaveBeenCalled()
  expect(h.attemptCount).not.toHaveBeenCalled()
  expect(h.attemptUpdateMany).not.toHaveBeenCalled()
  expect(h.leaseDeleteMany).not.toHaveBeenCalled()
}

describe('deobfuscation attempt and batch ownership', () => {
  it('denies batch history before task or attempt lookup', async () => {
    const response = await getBatches(new Request('http://localhost/api/projects/project-1/visualizer/deobfuscate/batches?taskId=task-1'), {
      params: Promise.resolve({ id: 'project-1' }),
    })

    expect(response.status).toBe(404)
    expect(h.strictAccess).toHaveBeenCalledWith({ userId: 'foreign-user' }, 'project-1')
    noProjectDataReadOrWrite()
  })

  it('denies batch cancellation before counting or changing attempts', async () => {
    const response = await cancelBatch(new Request('http://localhost'), {
      params: Promise.resolve({ id: 'project-1', batchId: 'agent-abcdefghijkl' }),
    })

    expect(response.status).toBe(404)
    expect(h.strictAccess).toHaveBeenCalledWith({ userId: 'foreign-user' }, 'project-1')
    noProjectDataReadOrWrite()
  })

  it('denies attempt status reads before loading result or source context', async () => {
    const response = await getAttempt(new Request('http://localhost'), {
      params: Promise.resolve({ id: 'project-1', attemptId: 'attempt-1' }),
    })

    expect(response.status).toBe(404)
    expect(h.strictAccess).toHaveBeenCalledWith({ userId: 'foreign-user' }, 'project-1')
    noProjectDataReadOrWrite()
  })

  it('denies attempt cancellation before updating status or releasing a lease', async () => {
    const response = await cancelAttempt(new Request('http://localhost'), {
      params: Promise.resolve({ id: 'project-1', attemptId: 'attempt-1' }),
    })

    expect(response.status).toBe(404)
    expect(h.strictAccess).toHaveBeenCalledWith({ userId: 'foreign-user' }, 'project-1')
    noProjectDataReadOrWrite()
  })
})

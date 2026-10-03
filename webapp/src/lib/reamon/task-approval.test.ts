/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  approvalFindFirst: vi.fn(),
  approvalUpdateMany: vi.fn(),
  taskUpdateMany: vi.fn(),
  taskFindUnique: vi.fn(),
  activityCreate: vi.fn(),
  approvalFindMany: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    reamonApproval: { findMany: mocks.approvalFindMany },
    $transaction: mocks.transaction,
  },
}))

import { decideTaskApproval, listTaskApprovals, taskRequiresApproval } from './task-approval'

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1', title: 'Inspect source', status: 'AWAITING_APPROVAL', progress: 0, error: '',
    createdAt: new Date('2026-10-03T10:00:00Z'), updatedAt: new Date('2026-10-03T10:00:00Z'), ...overrides,
  }
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-1', status: 'PENDING', requestedBy: 'user-1', decidedBy: null, reason: '',
    requestedAt: new Date('2026-10-03T10:00:00Z'), decidedAt: null, task: task(), ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.approvalFindFirst.mockResolvedValue(approval())
  mocks.approvalUpdateMany.mockResolvedValue({ count: 1 })
  mocks.taskUpdateMany.mockResolvedValue({ count: 1 })
  mocks.taskFindUnique.mockResolvedValue(task({ status: 'QUEUED' }))
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    reamonApproval: { findFirst: mocks.approvalFindFirst, updateMany: mocks.approvalUpdateMany },
    task: { updateMany: mocks.taskUpdateMany, findUnique: mocks.taskFindUnique },
    workspaceActivity: { create: mocks.activityCreate },
  }))
})

describe('task approval policy', () => {
  test('requires explicit approval only when the task option is set', () => {
    expect(taskRequiresApproval({ requiresApproval: true })).toBe(true)
    expect(taskRequiresApproval({ requiresApproval: false })).toBe(false)
    expect(taskRequiresApproval(null)).toBe(false)
  })
})

describe('decideTaskApproval', () => {
  test('approves a pending task and queues it for workers', async () => {
    const result = await decideTaskApproval('project-1', 'approval-1', 'approve', 'operator-1')

    expect(result).toMatchObject({ outcome: 'APPROVED', approval: { status: 'APPROVED', decidedBy: 'operator-1' }, task: { status: 'QUEUED' } })
    expect(mocks.approvalUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'approval-1', projectId: 'project-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'APPROVED', decidedBy: 'operator-1' }),
    }))
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-1', projectId: 'project-1', status: 'AWAITING_APPROVAL' },
      data: expect.objectContaining({ status: 'QUEUED' }),
    }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'analysis.task.approved' }) }))
  })

  test('rejects a pending task without allowing execution', async () => {
    mocks.taskFindUnique.mockResolvedValue(task({ status: 'CANCELLED', error: 'unsafe' }))

    const result = await decideTaskApproval('project-1', 'approval-1', 'reject', 'operator-1', 'unsafe input')

    expect(result).toMatchObject({ outcome: 'REJECTED', approval: { status: 'REJECTED', reason: 'unsafe input' }, task: { status: 'CANCELLED' } })
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED', error: 'unsafe input' }) }))
  })

  test('does not overwrite a prior decision', async () => {
    mocks.approvalFindFirst.mockResolvedValue(approval({ status: 'APPROVED', decidedBy: 'operator-1' }))

    const result = await decideTaskApproval('project-1', 'approval-1', 'reject', 'operator-2')

    expect(result).toMatchObject({ outcome: 'SKIPPED', approval: { status: 'APPROVED', decidedBy: 'operator-1' } })
    expect(mocks.approvalUpdateMany).not.toHaveBeenCalled()
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled()
  })
})

describe('listTaskApprovals', () => {
  test('bounds and serializes project-scoped approvals', async () => {
    mocks.approvalFindMany.mockResolvedValue([approval()])

    const result = await listTaskApprovals('project-1', 'PENDING')

    expect(result).toMatchObject([{ approval: { id: 'approval-1', status: 'PENDING' }, task: { id: 'task-1' } }])
    expect(mocks.approvalFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: 'project-1', status: 'PENDING' }, take: 100 }))
  })
})

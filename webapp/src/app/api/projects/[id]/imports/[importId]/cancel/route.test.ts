/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  transaction: vi.fn(),
  update: vi.fn(),
  activityCreate: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  default: {
    workspaceImport: { findFirst: mocks.findFirst },
    $transaction: mocks.transaction,
  },
}))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

import { POST } from './route'

function params() {
  return { params: Promise.resolve({ id: 'project-1', importId: 'import-1' }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.update.mockResolvedValue({ id: 'import-1', status: 'CANCELLED' })
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
    workspaceImport: { update: mocks.update },
    workspaceActivity: { create: mocks.activityCreate },
  }))
})

describe('POST /api/projects/[id]/imports/[importId]/cancel', () => {
  test('cancels a resumable import and records operator activity', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'import-1', status: 'UPLOADING', totalFiles: 10, completedFiles: 4, rootName: 'ExampleApp' })

    const response = await POST(new Request('http://localhost', { method: 'POST' }), params())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'CANCELLED', importId: 'import-1' })
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'CANCELLED', failedFiles: 6 }),
    }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'workspace.import.cancelled' }),
    }))
  })

  test('does not cancel a completed import', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'import-1', status: 'COMPLETED', totalFiles: 1, completedFiles: 1, rootName: 'ExampleApp' })

    const response = await POST(new Request('http://localhost', { method: 'POST' }), params())

    expect(response.status).toBe(409)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})

/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findingFindFirst: vi.fn(), findingUpdate: vi.fn(), activityCreate: vi.fn(), transaction: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ default: { $transaction: mocks.transaction } }))

import { isFindingStatus, reviewFinding } from './finding-review'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findingFindFirst.mockResolvedValue({ id: 'finding-1', title: 'Unsigned loader', status: 'OPEN', severity: 'high', source: 'provider', taskId: 'task-1', artifactId: 'artifact-1' })
  mocks.findingUpdate.mockResolvedValue({ id: 'finding-1', title: 'Unsigned loader', status: 'ACCEPTED', severity: 'high', source: 'provider', taskId: 'task-1', artifactId: 'artifact-1', updatedAt: new Date('2026-10-03T12:00:00Z') })
  mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    finding: { findFirst: mocks.findingFindFirst, update: mocks.findingUpdate },
    workspaceActivity: { create: mocks.activityCreate },
  }))
})

describe('REAmon finding review', () => {
  test('accepts only the durable finding lifecycle statuses', () => {
    expect(isFindingStatus('ACCEPTED')).toBe(true)
    expect(isFindingStatus('deleted')).toBe(false)
  })

  test('updates a project-scoped finding and records the review activity', async () => {
    const result = await reviewFinding('project-1', 'finding-1', 'ACCEPTED', 'operator-1', 'Confirmed in release build')
    expect(result).toMatchObject({ finding: { id: 'finding-1', status: 'ACCEPTED' }, note: 'Confirmed in release build' })
    expect(mocks.findingFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'finding-1', projectId: 'project-1' } }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'analysis.finding.reviewed', data: expect.objectContaining({ previousStatus: 'OPEN', status: 'ACCEPTED' }) }) }))
  })
})

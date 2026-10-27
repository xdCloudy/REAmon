import { describe, expect, test } from 'vitest'
import { summarizeWorkspaceTaskAttention } from './workspace-task-attention'

describe('workspace task attention', () => {
  const now = Date.parse('2026-10-27T12:00:00.000Z')

  test('reports queued work without exposing worker registry details', () => {
    expect(summarizeWorkspaceTaskAttention([
      { status: 'QUEUED', leaseHeartbeatAt: null },
      { status: 'AWAITING_APPROVAL', leaseHeartbeatAt: null },
    ], now)).toEqual({ kind: 'waiting' })
  })

  test('distinguishes queued work behind a task with a fresh lease', () => {
    expect(summarizeWorkspaceTaskAttention([
      { status: 'RUNNING', leaseHeartbeatAt: '2026-10-27T11:59:59.000Z' },
      { status: 'QUEUED', leaseHeartbeatAt: null },
    ], now)).toEqual({ kind: 'running-with-queued' })
  })

  test('reports running tasks whose leases are missing, invalid, or stale', () => {
    for (const leaseHeartbeatAt of [null, 'invalid', '2026-10-27T11:57:29.999Z']) {
      expect(summarizeWorkspaceTaskAttention([
        { status: 'RUNNING', leaseHeartbeatAt },
      ], now)).toEqual({ kind: 'stalled' })
    }
  })

  test('does not hide a stale running task when another task has a fresh lease', () => {
    expect(summarizeWorkspaceTaskAttention([
      { status: 'RUNNING', leaseHeartbeatAt: '2026-10-27T11:57:29.999Z' },
      { status: 'RUNNING', leaseHeartbeatAt: '2026-10-27T11:59:59.000Z' },
    ], now)).toEqual({ kind: 'stalled' })

    expect(summarizeWorkspaceTaskAttention([
      { status: 'RUNNING', leaseHeartbeatAt: null },
      { status: 'QUEUED', leaseHeartbeatAt: null },
      { status: 'RUNNING', leaseHeartbeatAt: '2026-10-27T11:59:59.000Z' },
    ], now)).toEqual({ kind: 'stalled-with-queued' })
  })

  test('does not alert on fresh running work or approval-only work', () => {
    expect(summarizeWorkspaceTaskAttention([
      { status: 'RUNNING', leaseHeartbeatAt: '2026-10-27T11:59:59.000Z' },
      { status: 'AWAITING_APPROVAL', leaseHeartbeatAt: null },
    ], now)).toBeNull()
  })
})

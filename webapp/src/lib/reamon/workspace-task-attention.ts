const TASK_LEASE_FRESH_MS = 150_000

export interface WorkspaceTaskLiveness {
  status: string
  leaseHeartbeatAt: string | null
}

export type WorkspaceTaskAttention =
  | { kind: 'waiting' }
  | { kind: 'running-with-queued' }
  | { kind: 'stalled-with-queued' }
  | { kind: 'stalled' }

export function summarizeWorkspaceTaskAttention(
  tasks: WorkspaceTaskLiveness[],
  now = Date.now(),
): WorkspaceTaskAttention | null {
  const hasQueued = tasks.some((task) => task.status === 'QUEUED')
  const runningTasks = tasks.filter((task) => task.status === 'RUNNING')
  const hasStaleLease = runningTasks.some((task) => {
    if (!task.leaseHeartbeatAt) return true
    const heartbeatAt = Date.parse(task.leaseHeartbeatAt)
    return !Number.isFinite(heartbeatAt) || heartbeatAt < now - TASK_LEASE_FRESH_MS
  })

  if (hasQueued && hasStaleLease) return { kind: 'stalled-with-queued' }
  if (hasQueued && runningTasks.length > 0) return { kind: 'running-with-queued' }
  if (hasQueued) return { kind: 'waiting' }
  if (runningTasks.length > 0 && hasStaleLease) return { kind: 'stalled' }
  return null
}

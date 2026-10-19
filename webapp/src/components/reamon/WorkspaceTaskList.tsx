'use client'

import { useState } from 'react'
import styles from './WorkspaceTaskList.module.css'

export interface WorkspaceTaskListItem {
  id: string
  title: string
  status: string
  progress: number
  progressMessage?: string | null
  error?: string | null
  startedAt?: string | null
  leaseOwner?: string | null
  leaseHeartbeatAt?: string | null
  approval?: { id: string; status: string } | null
}

export function heartbeatLabel(value: string | null | undefined): string {
  if (!value) return 'heartbeat pending'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'heartbeat unavailable'
  const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (ageSeconds < 5) return 'heartbeat fresh'
  if (ageSeconds < 60) return `heartbeat ${ageSeconds}s ago`
  return `heartbeat stale (${Math.floor(ageSeconds / 60)}m ago)`
}

function taskStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    AWAITING_APPROVAL: 'Needs approval',
    QUEUED: 'Queued',
    RUNNING: 'Running',
    COMPLETED: 'Complete',
    FAILED: 'Failed',
    CANCELLED: 'Cancelled',
  }
  return labels[status] || status.toLowerCase().replaceAll('_', ' ')
}

function isStaleForRecovery(task: WorkspaceTaskListItem): boolean {
  if (task.status !== 'RUNNING') return false
  const timestamp = Date.parse(task.leaseHeartbeatAt || task.startedAt || '')
  return Number.isFinite(timestamp) && Date.now() - timestamp >= 30 * 60 * 1000
}

export function WorkspaceTaskList({ projectId, tasks, onChanged }: {
  projectId: string
  tasks: WorkspaceTaskListItem[]
  onChanged?: () => void
}) {
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const hasStaleTasks = tasks.some(isStaleForRecovery)

  async function execute(task: WorkspaceTaskListItem) {
    setPendingAction(`execute:${task.id}`)
    setFeedback(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/tasks/${task.id}/execute`, { method: 'POST' })
      const payload = await response.json().catch(() => ({})) as { error?: string; outcome?: string }
      if (!response.ok) throw new Error(payload.error || 'Unable to execute analysis task')
      setFeedback(payload.outcome === 'COMPLETED' ? `${task.title} completed.` : 'Task execution finished without a completed result.')
      onChanged?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to execute analysis task')
    } finally {
      setPendingAction(null)
    }
  }

  async function retry(task: WorkspaceTaskListItem) {
    setPendingAction(`retry:${task.id}`)
    setFeedback(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/tasks/${task.id}/retry`, { method: 'POST' })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'Unable to retry analysis task')
      setFeedback(`${task.title} was requeued.`)
      onChanged?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to retry analysis task')
    } finally {
      setPendingAction(null)
    }
  }

  async function cancel(task: WorkspaceTaskListItem) {
    setPendingAction(`cancel:${task.id}`)
    setFeedback(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/tasks/${task.id}/cancel`, { method: 'POST' })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'Unable to cancel analysis task')
      setFeedback(`${task.title} was cancelled.`)
      onChanged?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to cancel analysis task')
    } finally {
      setPendingAction(null)
    }
  }

  async function decide(task: WorkspaceTaskListItem, decision: 'approve' | 'reject') {
    if (!task.approval) return
    setPendingAction(`${decision}:${task.id}`)
    setFeedback(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/approvals/${task.approval.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || `Unable to ${decision} task approval`)
      setFeedback(decision === 'approve' ? `${task.title} was approved.` : `${task.title} was rejected.`)
      onChanged?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : `Unable to ${decision} task approval`)
    } finally {
      setPendingAction(null)
    }
  }

  async function recoverStale() {
    setPendingAction('recover')
    setFeedback(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/tasks/recover`, { method: 'POST' })
      const payload = await response.json().catch(() => ({})) as { error?: string; recovered?: number }
      if (!response.ok) throw new Error(payload.error || 'Unable to recover stale tasks')
      setFeedback(payload.recovered ? `Recovered ${payload.recovered} stale task${payload.recovered === 1 ? '' : 's'}.` : 'No stale tasks needed recovery.')
      onChanged?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to recover stale tasks')
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <div className={styles.container}>
      {hasStaleTasks && <div className={styles.toolbar}>
        <span className={styles.toolbarHint}>A task has had no update for 30 minutes and may be stalled.</span>
        <button type="button" className={styles.actionButton} disabled={pendingAction !== null} onClick={() => void recoverStale()}>
          {pendingAction === 'recover' ? 'Recovering…' : 'Requeue stalled task'}
        </button>
      </div>}
      {feedback && <p className={styles.feedback} role="status">{feedback}</p>}
      {tasks.map((task) => (
        <div className={styles.row} key={task.id}>
          <span className={styles.title} title={task.error || undefined}>
            {task.title}
            {(task.status === 'FAILED' || task.status === 'CANCELLED')
              && task.progressMessage
              && task.progressMessage !== 'Analysis failed'
              && <small className={styles.progressMessage}>Last recorded step: {task.progressMessage}</small>}
            {task.error && <small className={styles.error}>{task.error}</small>}
          </span>
          <span className={styles.status} title={task.leaseOwner ? `Worker: ${task.leaseOwner}` : undefined}>
            <strong>{taskStatusLabel(task.status)}</strong>
            {task.status === 'RUNNING' && task.progressMessage && <small>{task.progressMessage}</small>}
            {task.status === 'RUNNING' && !task.leaseHeartbeatAt && !task.startedAt && <small>Waiting for the first worker update</small>}
            {isStaleForRecovery(task) && <small>No update for {heartbeatLabel(task.leaseHeartbeatAt || task.startedAt).replace('heartbeat stale (', '').replace(')', '')}</small>}
          </span>
          <span className={styles.actions}>
            {task.status === 'QUEUED' && <button type="button" className={styles.actionButton} disabled={pendingAction !== null} onClick={() => void execute(task)}>
              {pendingAction === `execute:${task.id}` ? 'Running…' : 'Run'}
            </button>}
            {(task.status === 'FAILED' || task.status === 'CANCELLED') && <button type="button" className={styles.actionButton} disabled={pendingAction !== null} onClick={() => void retry(task)}>
              {pendingAction === `retry:${task.id}` ? 'Requeuing…' : 'Retry'}
            </button>}
            {(task.status === 'QUEUED' || task.status === 'RUNNING') && <button type="button" className={styles.actionButton} disabled={pendingAction !== null} onClick={() => void cancel(task)}>
              {pendingAction === `cancel:${task.id}` ? 'Cancelling…' : 'Cancel'}
            </button>}
            {task.status === 'AWAITING_APPROVAL' && task.approval?.status === 'PENDING' && <>
              <button type="button" className={styles.actionButton} disabled={pendingAction !== null} onClick={() => void decide(task, 'approve')}>
                {pendingAction === `approve:${task.id}` ? 'Approving…' : 'Approve'}
              </button>
              <button type="button" className={styles.actionButton} disabled={pendingAction !== null} onClick={() => void decide(task, 'reject')}>
                {pendingAction === `reject:${task.id}` ? 'Rejecting…' : 'Reject'}
              </button>
            </>}
          </span>
        </div>
      ))}
    </div>
  )
}

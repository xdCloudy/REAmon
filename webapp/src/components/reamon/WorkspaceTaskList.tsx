'use client'

import { useState } from 'react'
import styles from './WorkspaceTaskList.module.css'

export interface WorkspaceTaskListItem {
  id: string
  title: string
  status: string
  progress: number
}

export function WorkspaceTaskList({ projectId, tasks, onChanged }: {
  projectId: string
  tasks: WorkspaceTaskListItem[]
  onChanged?: () => void
}) {
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

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
      <div className={styles.toolbar}>
        <span className={styles.toolbarHint}>Execution is lease-protected and safe to recover after a stalled run.</span>
        <button type="button" className={styles.actionButton} disabled={pendingAction !== null} onClick={() => void recoverStale()}>
          {pendingAction === 'recover' ? 'Recovering…' : 'Recover stale'}
        </button>
      </div>
      {feedback && <p className={styles.feedback} role="status">{feedback}</p>}
      {tasks.map((task) => (
        <div className={styles.row} key={task.id}>
          <span className={styles.title}>{task.title}</span>
          <span className={styles.status}>{task.status} · {task.progress}%</span>
          {task.status === 'QUEUED' && <button type="button" className={styles.actionButton} disabled={pendingAction !== null} onClick={() => void execute(task)}>
            {pendingAction === `execute:${task.id}` ? 'Running…' : 'Run'}
          </button>}
          {(task.status === 'FAILED' || task.status === 'CANCELLED') && <button type="button" className={styles.actionButton} disabled={pendingAction !== null} onClick={() => void retry(task)}>
            {pendingAction === `retry:${task.id}` ? 'Requeuing…' : 'Retry'}
          </button>}
        </div>
      ))}
    </div>
  )
}

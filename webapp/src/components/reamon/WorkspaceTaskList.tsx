'use client'

import { useState } from 'react'
import styles from './WorkspaceTaskList.module.css'

export interface WorkspaceTaskListItem {
  id: string
  title: string
  status: string
  progress: number
}

export function WorkspaceTaskList({ projectId, tasks, onExecuted }: {
  projectId: string
  tasks: WorkspaceTaskListItem[]
  onExecuted?: () => void
}) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  async function execute(task: WorkspaceTaskListItem) {
    setPendingId(task.id)
    setFeedback(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/tasks/${task.id}/execute`, { method: 'POST' })
      const payload = await response.json().catch(() => ({})) as { error?: string; outcome?: string }
      if (!response.ok) throw new Error(payload.error || 'Unable to execute analysis task')
      setFeedback(payload.outcome === 'COMPLETED' ? `${task.title} completed.` : 'Task execution finished without a completed result.')
      onExecuted?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to execute analysis task')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className={styles.container}>
      {feedback && <p className={styles.feedback} role="status">{feedback}</p>}
      {tasks.map((task) => (
        <div className={styles.row} key={task.id}>
          <span className={styles.title}>{task.title}</span>
          <span className={styles.status}>{task.status} · {task.progress}%</span>
          {task.status === 'QUEUED' && <button type="button" className={styles.runButton} disabled={pendingId !== null} onClick={() => void execute(task)}>
            {pendingId === task.id ? 'Running…' : 'Run'}
          </button>}
        </div>
      ))}
    </div>
  )
}

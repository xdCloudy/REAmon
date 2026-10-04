'use client'

import { useState } from 'react'
import styles from './WorkspaceDecompilationAction.module.css'

type TaskStatus = 'AWAITING_APPROVAL' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
type Feedback = { message: string; href?: string; linkLabel?: string }

export function WorkspaceDecompilationAction({ projectId, artifactId, providerId, hasPreviousRun, onChanged, onPendingChange }: {
  projectId: string
  artifactId: string
  providerId: string
  hasPreviousRun?: boolean
  onChanged?: () => void
  onPendingChange?: (pending: boolean) => void
}) {
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  function createRunAttemptId(): string {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  async function start() {
    if (pending) return
    setPending(true)
    onPendingChange?.(true)
    setFeedback(null)
    try {
      const scheduleResponse = await fetch(`/api/projects/${projectId}/workspace/analysis-plan/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifactId, providerId, capability: 'decompile', approvalRequired: false, runAttemptId: createRunAttemptId() }),
      })
      const scheduled = await scheduleResponse.json().catch(() => ({})) as {
        error?: string
        task?: { id?: string; status?: TaskStatus }
      }
      if (!scheduleResponse.ok) throw new Error(scheduled.error || 'Unable to start decompilation')
      const task = scheduled.task
      if (!task?.id || !task.status) throw new Error('The decompilation task was not created')
      onChanged?.()

      if (task.status !== 'QUEUED') {
        const current: Record<TaskStatus, Feedback> = {
          AWAITING_APPROVAL: { message: 'Approval is already pending. Approve the task, then choose Run under Tasks and findings.', href: '#analysis-tasks', linkLabel: 'Open task controls' },
          QUEUED: { message: 'Decompilation is queued. Choose Run under Tasks and findings.', href: '#analysis-tasks', linkLabel: 'Open task controls' },
          RUNNING: { message: 'Decompilation is already running. Track it under Tasks and findings.', href: '#analysis-tasks', linkLabel: 'Open task controls' },
          COMPLETED: { message: 'The previous decompilation run finished. Check its coverage in the code visualizer or start another run.', href: '#code-visualizer', linkLabel: 'Open code visualizer' },
          FAILED: { message: 'The previous decompilation failed. Retry it under Tasks and findings.', href: '#analysis-tasks', linkLabel: 'Open task controls' },
          CANCELLED: { message: 'The previous decompilation was cancelled. Retry it under Tasks and findings.', href: '#analysis-tasks', linkLabel: 'Open task controls' },
        }
        setFeedback(current[task.status])
        return
      }

      setFeedback({ message: 'Starting the isolated decompiler…' })
      const executionResponse = await fetch(`/api/projects/${projectId}/workspace/tasks/${task.id}/execute`, { method: 'POST' })
      const execution = await executionResponse.json().catch(() => ({})) as {
        error?: string
        outcome?: string
        task?: { status?: TaskStatus; error?: string }
      }
      if (!executionResponse.ok) {
        if (executionResponse.status === 409 && execution.task?.status === 'RUNNING') {
          setFeedback({ message: 'Decompilation is already running. Track it under Tasks and findings.', href: '#analysis-tasks', linkLabel: 'Open task controls' })
          return
        }
        throw new Error(execution.error || 'Unable to run decompilation')
      }

      const result: Record<TaskStatus, Feedback> = {
        AWAITING_APPROVAL: { message: 'Approval is required before this task can run.', href: '#analysis-tasks', linkLabel: 'Open task controls' },
        QUEUED: { message: 'Decompilation is queued. Choose Run under Tasks and findings.', href: '#analysis-tasks', linkLabel: 'Open task controls' },
        RUNNING: { message: 'Decompilation is running. Track its status under Tasks and findings.', href: '#analysis-tasks', linkLabel: 'Open task controls' },
        COMPLETED: { message: 'Decompilation run finished. Review indexed coverage and any truncation warnings in the code visualizer.', href: '#code-visualizer', linkLabel: 'Open code visualizer' },
        FAILED: { message: `Decompilation failed: ${execution.task?.error || 'the analyzer returned no result'}.`, href: '#analysis-tasks', linkLabel: 'Open task controls' },
        CANCELLED: { message: 'Decompilation was cancelled. Retry it under Tasks and findings.', href: '#analysis-tasks', linkLabel: 'Open task controls' },
      }
      const status = execution.task?.status
      setFeedback(status ? result[status] : { message: 'The decompilation task finished without a status.' })
      onChanged?.()
    } catch (error) {
      setFeedback({ message: error instanceof Error ? error.message : 'Unable to start decompilation' })
      onChanged?.()
    } finally {
      setPending(false)
      onPendingChange?.(false)
    }
  }

  return <div className={styles.container}>
    <button type="button" className={styles.action} disabled={pending} onClick={() => void start()}>
      {pending ? 'Starting decompilation…' : hasPreviousRun ? 'Run decompilation again' : 'Run decompilation'}
    </button>
    {feedback && <p className={styles.feedback} role="status">{feedback.message}{feedback.href && <a href={feedback.href}>{feedback.linkLabel}</a>}</p>}
  </div>
}

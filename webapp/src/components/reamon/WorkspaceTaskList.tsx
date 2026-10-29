'use client'

import { useEffect, useState } from 'react'
import styles from './WorkspaceTaskList.module.css'

export interface WorkspaceTaskListItem {
  id: string
  title: string
  status: string
  progress: number
  capability?: string | null
  investigationCase?: { id: string; status: string } | null
  progressMessage?: string | null
  error?: string | null
  startedAt?: string | null
  leaseOwner?: string | null
  leaseHeartbeatAt?: string | null
  approval?: { id: string; status: string } | null
}

interface InvestigationProvider { id: string; name: string; modelIdentifier: string }
interface InvestigationUnit { key: string; label: string; language: string; instructionFields: string[] }
interface InvestigationAttempt {
  id: string
  unitName?: string | null
  status: string
  resultSource?: string | null
  qualityReview?: { uncertainties?: string[]; syntaxValidation?: string; behavioralValidation?: string } | null
  errorMessage?: string | null
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
  const [investigationTaskId, setInvestigationTaskId] = useState<string | null>(null)
  const [investigationProviders, setInvestigationProviders] = useState<InvestigationProvider[]>([])
  const [investigationProviderId, setInvestigationProviderId] = useState('')
  const [investigationUnits, setInvestigationUnits] = useState<InvestigationUnit[]>([])
  const [investigationUnitKey, setInvestigationUnitKey] = useState('')
  const [activeInvestigation, setActiveInvestigation] = useState<{ taskId: string; attemptIds: string[] } | null>(null)
  const [investigationResults, setInvestigationResults] = useState<Record<string, InvestigationAttempt[]>>({})
  const hasStaleTasks = tasks.some(isStaleForRecovery)

  useEffect(() => {
    if (!activeInvestigation) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/workspace/tasks/${activeInvestigation.taskId}/investigation?summary=1`)
        if (!response.ok) throw new Error('Unable to refresh reconstruction status')
        const payload = await response.json() as { attempts?: InvestigationAttempt[] }
        const attempts = Array.isArray(payload.attempts) ? payload.attempts : []
        if (stopped) return
        setInvestigationResults((previous) => ({ ...previous, [activeInvestigation.taskId]: attempts }))
        const batch = activeInvestigation.attemptIds.map((id) => attempts.find((candidate) => candidate.id === id))
        if (batch.length > 0 && batch.every((attempt) => attempt && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(attempt.status))) {
          setActiveInvestigation(null)
          const succeeded = batch.filter((attempt) => attempt?.status === 'SUCCEEDED').length
          setFeedback(`${succeeded} of ${batch.length} reconstruction candidate${batch.length === 1 ? '' : 's'} ready for review. Behavior remains unvalidated.`)
          onChanged?.()
          return
        }
      } catch {
        // Keep the attempt resumable; the next bounded poll will retry status retrieval.
      }
      if (!stopped) timer = setTimeout(() => { void poll() }, 3000)
    }
    void poll()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [activeInvestigation, onChanged, projectId])

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

  async function queueInvestigation(task: WorkspaceTaskListItem) {
    setPendingAction(`investigate:${task.id}`)
    setFeedback(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/tasks/${task.id}/investigation`, { method: 'POST' })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'Unable to queue investigation')
      setFeedback(`${task.title} was queued for investigation.`)
      onChanged?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to queue investigation')
    } finally {
      setPendingAction(null)
    }
  }

  async function prepareInvestigation(task: WorkspaceTaskListItem) {
    setPendingAction(`providers:${task.id}`)
    setFeedback(null)
    try {
      const [providerResponse, caseResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}/visualizer/providers`),
        fetch(`/api/projects/${projectId}/workspace/tasks/${task.id}/investigation?summary=1`),
      ])
      const payload = await providerResponse.json().catch(() => ({})) as { error?: string; providers?: InvestigationProvider[] }
      if (!providerResponse.ok) throw new Error(payload.error || 'Unable to load saved AI providers')
      const casePayload = await caseResponse.json().catch(() => ({})) as { attempts?: InvestigationAttempt[]; candidateUnits?: InvestigationUnit[] }
      if (caseResponse.ok && Array.isArray(casePayload.attempts)) setInvestigationResults((previous) => ({ ...previous, [task.id]: casePayload.attempts || [] }))
      const providers = Array.isArray(payload.providers) ? payload.providers : []
      if (providers.length === 0) throw new Error('Add an OpenAI-compatible provider in Settings before running reconstruction')
      const units = Array.isArray(casePayload.candidateUnits) ? casePayload.candidateUnits : []
      if (units.length === 0) throw new Error('This failed run has no captured instruction unit in a supported reconstruction language')
      setInvestigationProviders(providers)
      setInvestigationProviderId(providers[0].id)
      setInvestigationUnits(units)
      setInvestigationUnitKey(units.length === 1 ? units[0].key : '')
      setInvestigationTaskId(task.id)
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to load saved AI providers')
    } finally {
      setPendingAction(null)
    }
  }

  async function runInvestigation(task: WorkspaceTaskListItem) {
    if (!investigationProviderId) return
    if (!investigationUnitKey) {
      setFeedback('Choose the code unit to reconstruct.')
      return
    }
    setPendingAction(`run-investigation:${task.id}`)
    setFeedback(null)
    try {
      const batch = investigationUnitKey === '__all__'
      const selectedUnits = batch ? investigationUnits.slice(0, 5) : investigationUnits.filter((unit) => unit.key === investigationUnitKey)
      const response = await fetch(`/api/projects/${projectId}/workspace/tasks/${task.id}/investigation/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch
          ? { providerId: investigationProviderId, unitKeys: selectedUnits.map((unit) => unit.key) }
          : { providerId: investigationProviderId, unitKey: investigationUnitKey }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; attempt?: { id: string }; attempts?: Array<{ id: string }> }
      if (!response.ok) throw new Error(payload.error || 'Unable to queue reconstruction')
      const attempts = Array.isArray(payload.attempts) && payload.attempts.length ? payload.attempts : payload.attempt ? [payload.attempt] : []
      setFeedback(`${attempts.length} reconstruction candidate${attempts.length === 1 ? '' : 's'} queued. They remain drafts until reviewed.`)
      setInvestigationTaskId(null)
      if (attempts.length) setActiveInvestigation({ taskId: task.id, attemptIds: attempts.map((attempt) => attempt.id) })
      onChanged?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to queue reconstruction')
    } finally {
      setPendingAction(null)
    }
  }

  async function cancelInvestigation(task: WorkspaceTaskListItem, attempt: InvestigationAttempt) {
    setPendingAction(`cancel-investigation:${attempt.id}`)
    try {
      const response = await fetch(`/api/projects/${projectId}/visualizer/deobfuscate/attempts/${attempt.id}/cancel`, { method: 'POST' })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'Unable to cancel reconstruction')
      setFeedback('Cancellation requested for the reconstruction attempt.')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to cancel reconstruction')
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
            {task.status === 'QUEUED' && <button type="button" className={styles.actionButton} aria-label={`${pendingAction === `execute:${task.id}` ? 'Running' : 'Run'} ${task.title}`} disabled={pendingAction !== null} onClick={() => void execute(task)}>
              {pendingAction === `execute:${task.id}` ? 'Running…' : 'Run'}
            </button>}
            {(task.status === 'FAILED' || task.status === 'CANCELLED') && <button type="button" className={styles.actionButton} aria-label={`Retry ${task.title}`} disabled={pendingAction !== null} onClick={() => void retry(task)}>
              {pendingAction === `retry:${task.id}` ? 'Requeuing…' : 'Retry'}
            </button>}
            {(task.status === 'FAILED' || task.status === 'CANCELLED')
              && (task.capability === 'decompile' || task.capability === 'disassemble')
              && <button type="button" className={styles.actionButton} aria-label={`Queue investigation for ${task.title}`} disabled={pendingAction !== null || Boolean(task.investigationCase)} onClick={() => void queueInvestigation(task)}>
                {pendingAction === `investigate:${task.id}` ? 'Queuing…' : task.investigationCase ? 'Investigation queued' : 'Investigate'}
              </button>}
            {task.investigationCase && <button type="button" className={styles.actionButton} aria-label={`Run investigation for ${task.title}`} disabled={pendingAction !== null} onClick={() => investigationTaskId === task.id ? void runInvestigation(task) : void prepareInvestigation(task)}>
              {pendingAction === `providers:${task.id}` ? 'Loading providers…' : pendingAction === `run-investigation:${task.id}` ? 'Queuing…' : 'Run investigation'}
            </button>}
            {(task.status === 'QUEUED' || task.status === 'RUNNING') && <button type="button" className={styles.actionButton} aria-label={`Cancel ${task.title}`} disabled={pendingAction !== null} onClick={() => void cancel(task)}>
              {pendingAction === `cancel:${task.id}` ? 'Cancelling…' : 'Cancel'}
            </button>}
            {task.status === 'AWAITING_APPROVAL' && task.approval?.status === 'PENDING' && <>
              <button type="button" className={styles.actionButton} aria-label={`Approve ${task.title}`} disabled={pendingAction !== null} onClick={() => void decide(task, 'approve')}>
                {pendingAction === `approve:${task.id}` ? 'Approving…' : 'Approve'}
              </button>
              <button type="button" className={styles.actionButton} aria-label={`Reject ${task.title}`} disabled={pendingAction !== null} onClick={() => void decide(task, 'reject')}>
                {pendingAction === `reject:${task.id}` ? 'Rejecting…' : 'Reject'}
              </button>
            </>}
          </span>
          {investigationTaskId === task.id && <label className={styles.investigationProvider}>
            AI provider
            <select aria-label={`AI provider for ${task.title}`} value={investigationProviderId} onChange={(event) => setInvestigationProviderId(event.target.value)}>
              {investigationProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.modelIdentifier}</option>)}
            </select>
          </label>}
          {investigationTaskId === task.id && investigationUnits.length > 1 && <label className={styles.investigationProvider}>
            Code unit
            <select aria-label={`Code unit for ${task.title}`} value={investigationUnitKey} onChange={(event) => setInvestigationUnitKey(event.target.value)}>
              <option value="">Choose a unit</option>
              <option value="__all__">All supported units (up to 5)</option>
              {investigationUnits.map((unit) => <option key={unit.key} value={unit.key}>{unit.label} · {unit.language} · {unit.instructionFields.join(', ')}</option>)}
            </select>
            {investigationUnitKey === '__all__' && <small>Runs the first {Math.min(5, investigationUnits.length)} captured units independently. Each result remains a separate draft.</small>}
          </label>}
          {(investigationResults[task.id] || []).map((attempt) => attempt.status === 'SUCCEEDED' && attempt.resultSource
            ? <details className={styles.investigationResult} key={attempt.id}>
              <summary>Generated reconstruction candidate · {attempt.unitName || 'Recovered code unit'} · syntax {attempt.qualityReview?.syntaxValidation || 'unavailable'} · behavior {attempt.qualityReview?.behavioralValidation || 'unavailable'}</summary>
              {attempt.qualityReview?.uncertainties?.length ? <ul>{attempt.qualityReview.uncertainties.map((uncertainty, index) => <li key={`${attempt.id}-${index}`}>{uncertainty}</li>)}</ul> : <p>No uncertainty notes were returned; that does not establish correctness.</p>}
              <pre>{attempt.resultSource}</pre>
            </details>
            : ['QUEUED', 'RUNNING'].includes(attempt.status) ? <p className={styles.investigationAttempt} key={attempt.id}>
              {attempt.unitName || 'Code unit'} reconstruction {attempt.status.toLowerCase()}
              <button type="button" className={styles.actionButton} aria-label={`Cancel reconstruction for ${attempt.unitName || 'code unit'}`} disabled={pendingAction !== null} onClick={() => void cancelInvestigation(task, attempt)}>
                {pendingAction === `cancel-investigation:${attempt.id}` ? 'Cancelling…' : 'Cancel reconstruction'}
              </button>
            </p>
              : ['FAILED', 'CANCELLED'].includes(attempt.status) ? <p className={styles.investigationAttempt} key={attempt.id}>{attempt.unitName || 'Code unit'} reconstruction {attempt.status.toLowerCase()}: {attempt.errorMessage || 'No candidate was produced.'}</p>
                : null)}
        </div>
      ))}
    </div>
  )
}

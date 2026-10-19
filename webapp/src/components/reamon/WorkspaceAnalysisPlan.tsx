'use client'

import { useState } from 'react'
import { ClipboardList, ScanSearch } from 'lucide-react'
import type { WorkspaceAnalysisPlan as AnalysisPlan, WorkspaceAnalysisPlanStep } from '@/lib/reamon/analysis-plan'
import type { CapabilityMatch, TargetProfile } from '@/lib/reamon'
import styles from './WorkspaceAnalysisPlan.module.css'

export interface WorkspaceAnalysisPlan extends AnalysisPlan {
  steps: Array<WorkspaceAnalysisPlanStep & { profile: TargetProfile; provider: CapabilityMatch }>
}

function createRunAttemptId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function isStaleRunningTask(step: WorkspaceAnalysisPlanStep): boolean {
  const task = step.latestTask
  if (task?.status !== 'RUNNING') return false
  const timestamp = Date.parse(task.leaseHeartbeatAt || task.updatedAt)
  return Number.isFinite(timestamp) && Date.now() - timestamp >= 30 * 60 * 1000
}

function taskLabel(step: WorkspaceAnalysisPlanStep): string {
  const task = step.latestTask
  if (!task) return 'Proposed'
  if (task.status === 'RUNNING' && isStaleRunningTask(step)) return 'Running · no update for 30 minutes'
  if (task.status === 'RUNNING') return `Running · ${task.progressMessage || 'Starting analysis'}`
  if (task.status === 'QUEUED') return 'Queued'
  if (task.status === 'AWAITING_APPROVAL') return 'Ready to run'
  if (task.status === 'COMPLETED') return 'Complete'
  if (task.status === 'FAILED') return 'Failed'
  if (task.status === 'CANCELLED') return 'Cancelled'
  return 'Proposed'
}

export function WorkspaceAnalysisPlanPanel({ projectId, plan, isLoading, isError, onScheduled, onScanned }: {
  projectId: string
  plan: WorkspaceAnalysisPlan | undefined
  isLoading: boolean
  isError: boolean
  onScheduled?: () => void
  onScanned?: () => void
}) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [visibleCount, setVisibleCount] = useState(8)

  async function scanProject() {
    setPendingId('scan')
    setFeedback(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/analysis-plan/scan`, { method: 'POST' })
      const payload = await response.json().catch(() => ({})) as {
        error?: string
        artifactsScanned?: number
        proposalCount?: number
        previousTasks?: number
        findings?: number
        hypotheses?: number
        evidence?: number
      }
      if (!response.ok) throw new Error(payload.error || 'Unable to scan project context')
      setFeedback(`Scanned ${payload.artifactsScanned || 0} files and rebuilt ${payload.proposalCount || 0} proposals using ${payload.previousTasks || 0} prior task results, ${payload.findings || 0} findings, ${payload.hypotheses || 0} hypotheses, and ${payload.evidence || 0} evidence records.`)
      onScanned?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to scan project context')
    } finally {
      setPendingId(null)
    }
  }

  async function run(step: WorkspaceAnalysisPlanStep) {
    setPendingId(`run:${step.id}`)
    setFeedback(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/analysis-plan/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifactId: step.artifactId,
          providerId: step.provider.pluginId,
          capability: step.capability,
          approvalRequired: false,
          runAttemptId: createRunAttemptId(),
        }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; task?: { status?: string } }
      if (!response.ok) throw new Error(payload.error || 'Unable to run analysis task')
      const status = payload.task?.status
      setFeedback(status === 'RUNNING'
        ? `${step.capability} is running for ${step.relativePath}.`
        : status === 'QUEUED'
          ? `${step.capability} is queued for ${step.relativePath}.`
          : status === 'COMPLETED'
            ? `The latest ${step.capability} run for ${step.relativePath} is complete.`
            : `${step.capability} was added to the project task list.`)
      onScheduled?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to run analysis task')
    } finally {
      setPendingId(null)
    }
  }

  async function clear(step: WorkspaceAnalysisPlanStep) {
    setPendingId(`clear:${step.id}`)
    setFeedback(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/analysis-plan/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalId: step.id,
          artifactId: step.artifactId,
          providerId: step.provider.pluginId,
          capability: step.capability,
        }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'Unable to clear proposal')
      setFeedback(`${step.capability} for ${step.relativePath} was cleared. Scan the project to restore it.`)
      onScheduled?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to clear proposal')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <section id="analysis-proposals" className={styles.panel} aria-labelledby="analysis-plan-heading">
      <div className={styles.header}>
        <div>
          <h2 id="analysis-plan-heading"><ClipboardList size={17} /> Analysis proposals</h2>
          <p>Run any compatible analysis directly. Scan the project to rebuild this list from workspace files and saved analysis results.</p>
        </div>
        <button type="button" className={styles.scanButton} disabled={pendingId !== null} onClick={() => void scanProject()}>
          <ScanSearch size={15} />{pendingId === 'scan' ? 'Scanning…' : 'Scan project'}
        </button>
      </div>
      {isLoading && <p className={styles.muted}>Preparing compatible analysis proposals…</p>}
      {isError && <p className={styles.error}>Analysis proposals are temporarily unavailable.</p>}
      {feedback && <p className={styles.feedback} role="status">{feedback}</p>}
      {plan?.lastProjectScan && <p className={styles.scanSummary}>
        Last scan: {new Date(plan.lastProjectScan.scannedAt).toLocaleString()} · {plan.lastProjectScan.artifactsScanned.toLocaleString()} files · {plan.lastProjectScan.previousTasks.toLocaleString()} prior tasks · {plan.lastProjectScan.findings.toLocaleString()} findings · {plan.lastProjectScan.evidence.toLocaleString()} evidence records.
      </p>}
      {!isLoading && !isError && plan && !plan.proposedSteps && <p className={styles.muted}>No compatible proposals are visible. Scan the project to restore cleared proposals and check for new capabilities.</p>}
      {!isLoading && !isError && plan && plan.proposedSteps > 0 && <>
        <p className={styles.summary}>
          {plan.proposedSteps.toLocaleString()} proposal{plan.proposedSteps === 1 ? '' : 's'} from {plan.candidateArtifacts.toLocaleString()} matching artifact{plan.candidateArtifacts === 1 ? '' : 's'}.
          {(plan.hasMoreArtifacts || plan.hasMoreSteps) && ' More candidates are available.'}
        </p>
        <div className={styles.list}>
          {plan.steps.slice(0, visibleCount).map((step) => {
            const taskStatus = step.latestTask?.status
            const staleRun = isStaleRunningTask(step)
            const isActive = taskStatus === 'QUEUED' || (taskStatus === 'RUNNING' && !staleRun)
            const runLabel = pendingId === `run:${step.id}` ? 'Starting…' : staleRun ? 'Run' : isActive ? (taskStatus === 'RUNNING' ? 'Running' : 'Queued') : step.previousRunCount ? 'Run again' : 'Run'
            return <div className={styles.row} key={step.id}>
              <span className={styles.path} title={step.relativePath}>{step.relativePath}</span>
              <span className={styles.provider}>{step.provider.pluginName}</span>
              <span className={styles.capability}>{step.capability}</span>
              <span className={styles.status}>
                {taskLabel(step)}
                {step.latestTask?.error && <small className={styles.taskError}>{step.latestTask.error}</small>}
              </span>
              {step.previousRunCount ? <span className={styles.history}>{step.previousRunCount} prior run{step.previousRunCount === 1 ? '' : 's'}</span> : <span className={styles.history} />}
              <span className={styles.actions}>
                <button
                  type="button"
                  className={styles.queueButton}
                  aria-label={`${runLabel} ${step.capability} for ${step.relativePath}`}
                  disabled={pendingId !== null || isActive}
                  onClick={() => void run(step)}
                >{runLabel}</button>
                <button type="button" className={styles.clearButton} aria-label={`Clear ${step.capability} proposal for ${step.relativePath}`} disabled={pendingId !== null} onClick={() => void clear(step)}>Clear</button>
              </span>
            </div>
          })}
        </div>
        {visibleCount < plan.steps.length && <button type="button" className={styles.moreButton} onClick={() => setVisibleCount((count) => Math.min(count + 8, plan.steps.length))}>Show {Math.min(8, plan.steps.length - visibleCount)} more proposals</button>}
        {plan.hasMoreSteps && visibleCount >= plan.steps.length && <p className={styles.muted}>There are more proposals than this page displays. Narrow the workspace inventory and scan again to view a subset.</p>}
      </>}
    </section>
  )
}

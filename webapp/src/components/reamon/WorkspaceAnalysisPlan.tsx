'use client'

import { useState } from 'react'
import { ClipboardList, ScanSearch } from 'lucide-react'
import type { WorkspaceAnalysisPlan as AnalysisPlan, WorkspaceAnalysisPlanStep } from '@/lib/reamon/analysis-plan'
import type { CapabilityMatch, TargetProfile } from '@/lib/reamon'
import styles from './WorkspaceAnalysisPlan.module.css'

export interface WorkspaceAnalysisPlan extends AnalysisPlan {
  steps: Array<WorkspaceAnalysisPlanStep & { profile: TargetProfile; provider: CapabilityMatch }>
}

interface ProposalContinuationPage {
  planKey: string
  steps: WorkspaceAnalysisPlan['steps']
  hasMoreSteps: boolean
  nextStepOffset: number | null
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
  const [continuationPages, setContinuationPages] = useState<ProposalContinuationPage[]>([])
  const [visibleState, setVisibleState] = useState<{ planKey: string; count: number }>({ planKey: '', count: 8 })
  const planKey = plan ? JSON.stringify([projectId, plan.query, plan.snapshotId, plan.steps.map((step) => step.id)]) : ''
  const loadedPages = continuationPages.filter((page) => page.planKey === planKey)
  const allSteps = plan ? [...plan.steps, ...loadedPages.flatMap((page) => page.steps)] : []
  const visibleCount = visibleState.planKey === planKey ? visibleState.count : 8
  const latestPage = loadedPages.at(-1)
  const hasMoreSteps = latestPage?.hasMoreSteps ?? plan?.hasMoreSteps ?? false
  const nextStepOffset = latestPage?.nextStepOffset ?? plan?.nextStepOffset ?? null

  async function loadMoreSteps() {
    if (!plan || !hasMoreSteps || nextStepOffset === null) return
    setPendingId('proposal-page')
    setFeedback(null)
    try {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(plan.query)) {
        if (key === 'stepOffset' || key === 'stepLimit' || key === 'snapshotId' || value === undefined) continue
        params.set(key, String(value))
      }
      params.set('stepOffset', String(nextStepOffset))
      params.set('stepLimit', String(plan.stepLimit))
      params.set('snapshotId', plan.snapshotId)
      const response = await fetch(`/api/projects/${projectId}/workspace/analysis-plan?${params.toString()}`)
      const payload = await response.json().catch(() => ({})) as WorkspaceAnalysisPlan & {
        error?: string | { message?: string }
      }
      if (!response.ok) {
        const message = typeof payload.error === 'string' ? payload.error : payload.error?.message
        throw new Error(message || 'Unable to load the next proposal page')
      }
      if (payload.snapshotId !== plan.snapshotId || payload.stepOffset !== nextStepOffset) {
        throw new Error('Workspace proposals changed. Refresh the proposal list and continue from its first page.')
      }
      setContinuationPages((current) => [
        ...current.filter((page) => page.planKey === planKey),
        {
          planKey,
          steps: payload.steps,
          hasMoreSteps: payload.hasMoreSteps,
          nextStepOffset: payload.nextStepOffset,
        },
      ])
      const loadedBefore = plan.steps.length + loadedPages.reduce((count, page) => count + page.steps.length, 0)
      setVisibleState({ planKey, count: Math.max(visibleCount, loadedBefore + Math.min(8, payload.steps.length)) })
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to load the next proposal page')
    } finally {
      setPendingId(null)
    }
  }

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
      setContinuationPages([])
      setVisibleState({ planKey, count: 8 })
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
      setContinuationPages([])
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
      setContinuationPages([])
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
      {!isLoading && !isError && plan && !plan.proposedSteps && !hasMoreSteps && <p className={styles.muted}>No compatible proposals are visible. Scan the project to restore cleared proposals and check for new capabilities.</p>}
      {!isLoading && !isError && plan && (plan.proposedSteps > 0 || hasMoreSteps) && <>
        <p className={styles.summary}>
          {plan.proposedSteps.toLocaleString()} visible proposal{plan.proposedSteps === 1 ? '' : 's'} on this page from {plan.returnedArtifacts.toLocaleString()} of {plan.candidateArtifacts.toLocaleString()} matching artifacts.
          {hasMoreSteps && ` ${plan.totalCandidateSteps.toLocaleString()} candidate steps are available in this artifact page.`}
          {plan.hasMoreArtifacts && ' More artifact pages are available.'}
        </p>
        <div className={styles.list}>
          {allSteps.slice(0, visibleCount).map((step) => {
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
        {visibleCount < allSteps.length && <button type="button" className={styles.moreButton} onClick={() => setVisibleState((current) => ({ planKey, count: Math.min((current.planKey === planKey ? current.count : 8) + 8, allSteps.length) }))}>Show {Math.min(8, allSteps.length - visibleCount)} more proposals</button>}
        {hasMoreSteps && <button type="button" className={styles.moreButton} disabled={pendingId !== null} onClick={() => void loadMoreSteps()}>{pendingId === 'proposal-page' ? 'Loading proposals…' : `Load next ${plan.stepLimit} proposal ${plan.stepLimit === 1 ? 'step' : 'steps'}`}</button>}
      </>}
    </section>
  )
}

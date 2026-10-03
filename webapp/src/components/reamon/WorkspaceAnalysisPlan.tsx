'use client'

import { useState } from 'react'
import { ClipboardList } from 'lucide-react'
import type { CapabilityMatch, TargetProfile } from '@/lib/reamon'
import styles from './WorkspaceAnalysisPlan.module.css'

export interface WorkspaceAnalysisPlan {
  candidateArtifacts: number
  returnedArtifacts: number
  proposedSteps: number
  steps: Array<{
    id: string
    status: 'PROPOSED'
    artifactId: string
    relativePath: string
    profile: TargetProfile
    capability: string
    provider: CapabilityMatch
    reason: string
  }>
  hasMoreArtifacts: boolean
  hasMoreSteps: boolean
}

export function WorkspaceAnalysisPlanPanel({ projectId, plan, isLoading, isError, onScheduled }: {
  projectId: string
  plan: WorkspaceAnalysisPlan | undefined
  isLoading: boolean
  isError: boolean
  onScheduled?: () => void
}) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  async function schedule(step: WorkspaceAnalysisPlan['steps'][number]) {
    setPendingId(step.id)
    setFeedback(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/analysis-plan/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ artifactId: step.artifactId, providerId: step.provider.pluginId, capability: step.capability, approvalRequired: true }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; reused?: boolean; task?: { status?: string } }
      if (!response.ok) throw new Error(payload.error || 'Unable to queue analysis task')
      setFeedback(payload.reused ? 'This analysis proposal is already queued or awaiting approval.' : `${step.capability} is awaiting operator approval for ${step.relativePath}.`)
      onScheduled?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to queue analysis task')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="analysis-plan-heading">
      <div className={styles.header}>
        <div>
          <h2 id="analysis-plan-heading"><ClipboardList size={17} /> Analysis proposals</h2>
          <p>Deterministic provider matches from the active inventory. Each proposal requests operator approval before execution.</p>
        </div>
        {plan && <span className={styles.badge}>QUEUEABLE</span>}
      </div>
      {isLoading && <p className={styles.muted}>Preparing compatible analysis proposals…</p>}
      {isError && <p className={styles.error}>Analysis proposals are temporarily unavailable.</p>}
      {feedback && <p className={styles.feedback} role="status">{feedback}</p>}
      {!isLoading && !isError && plan && !plan.proposedSteps && <p className={styles.muted}>No compatible provider capabilities were found in the current inventory page.</p>}
      {!isLoading && !isError && plan && plan.proposedSteps > 0 && <>
        <p className={styles.summary}>
          {plan.proposedSteps.toLocaleString()} proposal{plan.proposedSteps === 1 ? '' : 's'} from {plan.candidateArtifacts.toLocaleString()} matching artifact{plan.candidateArtifacts === 1 ? '' : 's'}.
          {(plan.hasMoreArtifacts || plan.hasMoreSteps) && ' More candidates are available.'}
        </p>
        <div className={styles.list}>
          {plan.steps.slice(0, 8).map((step) => (
            <div className={styles.row} key={step.id}>
              <span className={styles.path} title={step.relativePath}>{step.relativePath}</span>
              <span className={styles.provider}>{step.provider.pluginName}</span>
              <span className={styles.capability}>{step.capability}</span>
              <span className={styles.status}>{step.status}</span>
              <button type="button" className={styles.queueButton} disabled={pendingId !== null} onClick={() => void schedule(step)}>
                {pendingId === step.id ? 'Requesting…' : 'Request approval'}
              </button>
            </div>
          ))}
        </div>
        {plan.proposedSteps > 8 && <p className={styles.muted}>Showing the first 8 proposals. Use the inventory filters for a narrower plan.</p>}
      </>}
    </section>
  )
}

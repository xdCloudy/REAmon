'use client'

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

export function WorkspaceAnalysisPlanPanel({ plan, isLoading, isError }: {
  plan: WorkspaceAnalysisPlan | undefined
  isLoading: boolean
  isError: boolean
}) {
  return (
    <section className={styles.panel} aria-labelledby="analysis-plan-heading">
      <div className={styles.header}>
        <div>
          <h2 id="analysis-plan-heading"><ClipboardList size={17} /> Analysis proposals</h2>
          <p>Deterministic provider matches from the active inventory. Proposals do not execute tools.</p>
        </div>
        {plan && <span className={styles.badge}>PROPOSAL ONLY</span>}
      </div>
      {isLoading && <p className={styles.muted}>Preparing compatible analysis proposals…</p>}
      {isError && <p className={styles.error}>Analysis proposals are temporarily unavailable.</p>}
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
            </div>
          ))}
        </div>
        {plan.proposedSteps > 8 && <p className={styles.muted}>Showing the first 8 proposals. Use the inventory filters for a narrower plan.</p>}
      </>}
    </section>
  )
}


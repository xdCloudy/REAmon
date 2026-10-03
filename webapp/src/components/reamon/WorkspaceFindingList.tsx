'use client'

import { useState } from 'react'
import styles from './WorkspaceFindingList.module.css'

interface WorkspaceFinding { id: string; title: string; severity: string; status: string }

export function WorkspaceFindingList({ projectId, findings, onChanged }: { projectId: string; findings: WorkspaceFinding[]; onChanged?: () => void }) {
  const [pending, setPending] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  async function review(finding: WorkspaceFinding, status: 'REVIEWING' | 'ACCEPTED' | 'REJECTED' | 'VERIFIED') {
    setPending(`${finding.id}:${status}`)
    setFeedback(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/workspace/findings/${finding.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || 'Unable to review finding')
      setFeedback(`${finding.title} marked ${status.toLowerCase()}.`)
      onChanged?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to review finding')
    } finally {
      setPending(null)
    }
  }

  return <div className={styles.container}>
    {feedback && <p className={styles.feedback} role="status">{feedback}</p>}
    {findings.map((finding) => <div className={styles.row} key={finding.id}>
      <span className={styles.title}><strong>{finding.title}</strong><small>{finding.severity} · {finding.status}</small></span>
      <span className={styles.actions}>
        {finding.status === 'OPEN' && <button type="button" disabled={pending !== null} onClick={() => void review(finding, 'REVIEWING')}>{pending === `${finding.id}:REVIEWING` ? 'Opening…' : 'Review'}</button>}
        {(finding.status === 'OPEN' || finding.status === 'REVIEWING') && <>
          <button type="button" disabled={pending !== null} onClick={() => void review(finding, 'ACCEPTED')}>{pending === `${finding.id}:ACCEPTED` ? 'Accepting…' : 'Accept'}</button>
          <button type="button" disabled={pending !== null} onClick={() => void review(finding, 'REJECTED')}>{pending === `${finding.id}:REJECTED` ? 'Rejecting…' : 'Reject'}</button>
        </>}
        {finding.status === 'ACCEPTED' && <button type="button" disabled={pending !== null} onClick={() => void review(finding, 'VERIFIED')}>{pending === `${finding.id}:VERIFIED` ? 'Verifying…' : 'Verify'}</button>}
      </span>
    </div>)}
  </div>
}

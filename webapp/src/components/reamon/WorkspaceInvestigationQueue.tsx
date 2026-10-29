'use client'

import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import styles from './WorkspaceInvestigationQueue.module.css'

interface InvestigationAttemptSummary {
  id: string
  unitName: string
  status: string
  errorCode: string | null
  validationStatus: string | null
  candidateAvailable: boolean
  createdAt: string
  completedAt: string | null
}

interface InvestigationCaseSummary {
  id: string
  taskId: string
  artifactSha256: string
  capability: string
  providerId: string | null
  providerVersion: string | null
  status: string
  attemptCount: number
  hasCandidate: boolean
  active: boolean
  task: { title: string; status: string; capability: string }
  attempts: InvestigationAttemptSummary[]
}

interface InvestigationQueuePage {
  investigations: InvestigationCaseSummary[]
  nextCursor: string | null
}

async function fetchQueue(projectId: string, cursor: string | null): Promise<InvestigationQueuePage> {
  const params = new URLSearchParams({ limit: '25' })
  if (cursor) params.set('cursor', cursor)
  const response = await fetch(`/api/projects/${projectId}/workspace/investigations?${params}`)
  if (!response.ok) throw new Error('Unable to load investigation queue')
  return response.json()
}

function openTask(taskId: string) {
  const section = document.getElementById('analysis-tasks') as HTMLDetailsElement | null
  if (section) section.open = true
  requestAnimationFrame(() => {
    document.getElementById(`workspace-task-${taskId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

export function WorkspaceInvestigationQueue({ projectId }: { projectId: string }) {
  const [expanded, setExpanded] = useState(false)
  const queue = useInfiniteQuery({
    queryKey: ['reamon-investigations', projectId],
    queryFn: ({ pageParam }) => fetchQueue(projectId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: expanded,
    refetchInterval: (query) => {
      if (!expanded) return false
      const hasActiveWork = query.state.data?.pages.some((page) => page.investigations.some((item) => item.active))
      return hasActiveWork ? 3000 : 15000
    },
    refetchIntervalInBackground: false,
  })
  const cases = queue.data?.pages.flatMap((page) => page.investigations) ?? []

  return (
    <details className={styles.queue} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>Investigation queue <span>{cases.length ? `${cases.length} loaded` : 'failed and incomplete units'}</span></summary>
      {queue.isLoading && <p className={styles.muted}>Loading saved investigation cases…</p>}
      {queue.isError && <p className={styles.error} role="alert">The project investigation queue could not be loaded.</p>}
      {queue.isSuccess && cases.length === 0 && <p className={styles.muted}>No failed decompile or disassemble runs have been queued for investigation.</p>}
      <div className={styles.list}>
        {cases.map((item) => (
          <article className={styles.case} key={item.id}>
            <div className={styles.heading}>
              <strong>{item.task.title}</strong>
              <span>{item.status.toLowerCase().replaceAll('_', ' ')}</span>
            </div>
            <p>{item.capability} · {item.task.status.toLowerCase()} · {item.attemptCount} investigation attempt{item.attemptCount === 1 ? '' : 's'}</p>
            <small>Input SHA-256 {item.artifactSha256.slice(0, 12)}…{item.hasCandidate ? ' · candidate saved for review' : ''}{item.active ? ' · agent work active' : ''}</small>
            {item.attempts.length > 0 && <ul>
              {item.attempts.map((attempt) => <li key={attempt.id}>
                {attempt.unitName || 'Code unit'} · {attempt.status.toLowerCase()}
                {attempt.candidateAvailable ? ' · candidate saved' : ''}
                {attempt.validationStatus ? ` · ${attempt.validationStatus.toLowerCase().replaceAll('_', ' ')}` : ''}
              </li>)}
            </ul>}
            <button type="button" className={styles.button} onClick={() => openTask(item.taskId)}>Open task controls</button>
          </article>
        ))}
      </div>
      {queue.hasNextPage && <button type="button" className={styles.button} disabled={queue.isFetchingNextPage} onClick={() => void queue.fetchNextPage()}>
        {queue.isFetchingNextPage ? 'Loading…' : 'Load more investigations'}
      </button>}
    </details>
  )
}

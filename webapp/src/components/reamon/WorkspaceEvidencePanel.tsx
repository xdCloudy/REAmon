'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './WorkspaceFileTree.module.css'

interface EvidenceSummary {
  id: string
  targetId: string | null
  artifactId: string | null
  kind: string
  summary: string
  summaryTruncated: boolean
  source: string
  createdAt: string
}

interface EvidenceListPage {
  evidence: EvidenceSummary[]
  total: number
  hasMore: boolean
  nextCursor: string | null
}

interface EvidenceDetailPage {
  evidenceHash: string
  totalBytes: number
  detailsJson: string
  nextOffsetBytes: number
  hasMore: boolean
}

export function WorkspaceEvidencePanel({ projectId, artifactId }: { projectId: string; artifactId: string }) {
  const [page, setPage] = useState<EvidenceListPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<EvidenceDetailPage | null>(null)
  const [detailJson, setDetailJson] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailLoadingMore, setDetailLoadingMore] = useState(false)
  const [detailError, setDetailError] = useState(false)
  const detailRequest = useRef(0)

  const loadFirstPage = useCallback(async (signal?: AbortSignal) => {
    setPage(null)
    setLoading(true)
    setError(false)
    setDetailId(null)
    setDetail(null)
    setDetailJson('')
    setDetailLoading(false)
    setDetailLoadingMore(false)
    setDetailError(false)
    detailRequest.current += 1
    try {
      const params = new URLSearchParams({ artifactId, limit: '10' })
      const response = await fetch(`/api/projects/${projectId}/workspace/evidence?${params}`, signal ? { signal } : undefined)
      if (!response.ok) throw new Error('Unable to load artifact evidence')
      const firstPage = await response.json() as EvidenceListPage
      if (!signal?.aborted) setPage(firstPage)
    } catch {
      if (!signal?.aborted) setError(true)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [artifactId, projectId])

  useEffect(() => {
    const controller = new AbortController()
    setPage(null)
    void loadFirstPage(controller.signal)
    return () => controller.abort()
  }, [loadFirstPage])

  const loadMore = async () => {
    if (!page?.hasMore || !page.nextCursor || loadingMore) return
    setLoadingMore(true)
    setError(false)
    try {
      const params = new URLSearchParams({ artifactId, limit: '10', cursor: page.nextCursor })
      const response = await fetch(`/api/projects/${projectId}/workspace/evidence?${params}`)
      if (!response.ok) throw new Error('Unable to load the next evidence page')
      const nextPage = await response.json() as EvidenceListPage
      setPage((current) => current ? { ...nextPage, evidence: [...current.evidence, ...nextPage.evidence] } : nextPage)
    } catch {
      setError(true)
    } finally {
      setLoadingMore(false)
    }
  }

  const loadDetail = async (evidenceId: string, offsetBytes = 0, evidenceHash?: string) => {
    const requestId = ++detailRequest.current
    if (offsetBytes === 0) {
      setDetailId(evidenceId)
      setDetail(null)
      setDetailJson('')
      setDetailError(false)
      setDetailLoading(true)
    } else {
      setDetailLoadingMore(true)
      setDetailError(false)
    }
    try {
      const params = new URLSearchParams({ offsetBytes: String(offsetBytes) })
      if (evidenceHash) params.set('evidenceHash', evidenceHash)
      const response = await fetch(`/api/projects/${projectId}/workspace/evidence/${encodeURIComponent(evidenceId)}?${params}`)
      if (!response.ok) throw new Error('Unable to load evidence details')
      const nextPage = await response.json() as EvidenceDetailPage
      if (requestId !== detailRequest.current) return
      setDetail(nextPage)
      setDetailJson((current) => offsetBytes === 0 ? nextPage.detailsJson : current + nextPage.detailsJson)
    } catch {
      if (requestId === detailRequest.current) setDetailError(true)
    } finally {
      if (requestId === detailRequest.current) {
        setDetailLoading(false)
        setDetailLoadingMore(false)
      }
    }
  }

  const selectedSummary = page?.evidence.find((item) => item.id === detailId)

  return (
    <section className={styles.evidencePanel} aria-label="Persisted artifact evidence">
      <p className={styles.detailLabel}>Persisted artifact evidence</p>
      {loading && <p className={styles.evidenceState}>Loading evidence…</p>}
      {error && <div><p className={styles.detailError} role="alert">Evidence is temporarily unavailable.</p><button type="button" className="secondaryButton" onClick={() => void loadFirstPage()} disabled={loading}>Retry evidence</button></div>}
      {!loading && !error && page && page.evidence.length === 0 && <p className={styles.evidenceState}>No persisted evidence for this artifact.</p>}
      {page && page.evidence.length > 0 && <>
        <span className={styles.evidenceCount}>Showing {page.evidence.length.toLocaleString()} of {page.total.toLocaleString()} records</span>
        <ul className={styles.evidenceList}>
          {page.evidence.map((item) => (
            <li key={item.id}>
              <button type="button" className={styles.evidenceSelect} aria-pressed={detailId === item.id} onClick={() => void loadDetail(item.id)}>
                <strong>{item.kind}</strong><span>{item.summary}{item.summaryTruncated ? '…' : ''}</span><small>{item.source}</small>
              </button>
            </li>
          ))}
        </ul>
        {page.hasMore && <button type="button" className="secondaryButton" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? 'Loading evidence…' : 'Load more evidence'}</button>}
      </>}
      {selectedSummary && <div className={styles.evidenceDetail}>
        <p className={styles.detailLabel}>Full evidence: {selectedSummary.kind}</p>
        {detailLoading && <p className={styles.evidenceState}>Loading full details…</p>}
        {detailError && <p className={styles.detailError} role="alert">Evidence details changed or could not be loaded. Select the record to restart.</p>}
        {detailJson && <>
          <pre aria-label="Evidence JSON">{detailJson}{detail?.hasMore ? '\n…' : ''}</pre>
          {detail?.hasMore && <button type="button" className="secondaryButton" onClick={() => void loadDetail(selectedSummary.id, detail.nextOffsetBytes, detail.evidenceHash)} disabled={detailLoadingMore}>{detailLoadingMore ? 'Loading details…' : 'Load next detail page'}</button>}
        </>}
      </div>}
    </section>
  )
}

'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CodeUnit } from '@/lib/reamon/code-units'
import styles from './ProjectFunctionAgentQueue.module.css'

const MAX_FUNCTIONS = 10
const MAX_SOURCE_UNITS_TO_SCAN = 40
const MAX_MEMBER_REWRITE_BYTES = 64 * 1024
const MAX_OUTLINE_SOURCE_BYTES = 2 * 1024 * 1024

interface CodeUnitsPage {
  units: CodeUnit[]
  nextCursor: string | null
  hasMore: boolean
}

interface MemberOutline {
  name: string
  kind: string
  start_byte: number
  end_byte: number
  line: number
  source_bytes: number
}

interface QueueAttempt {
  id: string
  codeUnitId: string
  unitName: string
  language: string
  memberName: string
  status: string
  cancelRequested: boolean
  errorMessage: string | null
  validationStatus: string | null
  validationMethod: string | null
  createdAt: string
  completedAt: string | null
}

interface QueueResponse {
  batch: { id: string; createdAt: string; attempts: QueueAttempt[] } | null
}

const EMPTY_ATTEMPTS: QueueAttempt[] = []

interface QueueCandidate {
  unit: { id: string; name: string; language: string }
  member: MemberOutline
}

interface QueueSourceUnit {
  id: string
  name: string
  language: string
  memberOffset: number
}

interface QueueScanState {
  version: 1
  cursor: string | null
  complete: boolean
  backlog: QueueCandidate[]
  pendingUnits: QueueSourceUnit[]
  segmentAfterCursor: string | null
  segmentComplete: boolean
  segmentActive: boolean
}

function isQueueCandidate(value: unknown): value is QueueCandidate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<QueueCandidate>
  const member = candidate.member
  return Boolean(candidate.unit && typeof candidate.unit.id === 'string' && candidate.unit.id.length <= 128
    && typeof candidate.unit.name === 'string' && candidate.unit.name.length <= 500
    && typeof candidate.unit.language === 'string' && candidate.unit.language.length <= 80
    && member && typeof member.name === 'string' && member.name.length <= 500
    && typeof member.kind === 'string' && member.kind.length <= 100
    && Number.isSafeInteger(member.start_byte) && Number.isSafeInteger(member.end_byte)
    && Number.isSafeInteger(member.line) && member.line >= 1 && Number.isSafeInteger(member.source_bytes)
    && member.start_byte >= 0 && member.end_byte > member.start_byte
    && member.source_bytes > 0 && member.source_bytes <= MAX_MEMBER_REWRITE_BYTES)
}

function isQueueSourceUnit(value: unknown): value is QueueSourceUnit {
  if (!value || typeof value !== 'object') return false
  const unit = value as Partial<QueueSourceUnit>
  return typeof unit.id === 'string' && unit.id.length <= 128
    && typeof unit.name === 'string' && unit.name.length <= 500
    && typeof unit.language === 'string' && unit.language.length <= 80
    && typeof unit.memberOffset === 'number' && Number.isSafeInteger(unit.memberOffset) && unit.memberOffset >= 0
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({})) as { error?: string }
  return payload.error || fallback
}

async function fetchCodeUnitPage(projectId: string, taskId: string, cursor: string | null): Promise<CodeUnitsPage> {
  const params = new URLSearchParams({ taskId })
  if (cursor) params.set('cursor', cursor)
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer?${params}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(await responseError(response, 'Could not load code units from the selected analysis run'))
  return response.json() as Promise<CodeUnitsPage>
}

async function fetchOutline(projectId: string, unit: Pick<CodeUnit, 'id'>): Promise<MemberOutline[]> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unitId: unit.id, scope: 'outline' }),
  })
  if (!response.ok) throw new Error(await responseError(response, 'Could not outline source functions'))
  const payload = await response.json() as { members?: MemberOutline[]; unsupported?: boolean }
  if (payload.unsupported) return []
  return Array.isArray(payload.members) ? payload.members : []
}

export function ProjectFunctionAgentQueue({ projectId, taskId, providerId, reviewerProviderId }: {
  projectId: string
  taskId: string | null
  providerId: string
  reviewerProviderId: string
}) {
  const queryClient = useQueryClient()
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [scanCursor, setScanCursor] = useState<string | null>(null)
  const [scanComplete, setScanComplete] = useState(false)
  const [candidateBacklog, setCandidateBacklog] = useState<QueueCandidate[]>([])
  const [pendingUnits, setPendingUnits] = useState<QueueSourceUnit[]>([])
  const [segmentAfterCursor, setSegmentAfterCursor] = useState<string | null>(null)
  const [segmentComplete, setSegmentComplete] = useState(false)
  const [segmentActive, setSegmentActive] = useState(false)
  const [scanStateReady, setScanStateReady] = useState(false)
  const scanStateKey = taskId ? `reamon-function-queue:v2:${projectId}:${taskId}` : ''

  useEffect(() => {
    setScanStateReady(false)
    if (!scanStateKey) {
      setScanCursor(null)
      setScanComplete(false)
      setCandidateBacklog([])
      setPendingUnits([])
      setSegmentAfterCursor(null)
      setSegmentComplete(false)
      setSegmentActive(false)
      setScanStateReady(true)
      return
    }
    try {
      const saved = sessionStorage.getItem(scanStateKey)
      const state = saved ? JSON.parse(saved) as Partial<QueueScanState> : null
      const backlog = Array.isArray(state?.backlog) && state.backlog.length <= 10_000 && state.backlog.every(isQueueCandidate)
        ? state.backlog : []
      const savedPendingUnits = Array.isArray(state?.pendingUnits) && state.pendingUnits.length <= MAX_SOURCE_UNITS_TO_SCAN
        && state.pendingUnits.every(isQueueSourceUnit) ? state.pendingUnits : []
      setScanCursor(state?.version === 1 && (state.cursor === null || typeof state.cursor === 'string' && state.cursor.length <= 500) ? state.cursor : null)
      setScanComplete(state?.version === 1 && state.complete === true)
      setCandidateBacklog(backlog)
      setPendingUnits(savedPendingUnits)
      setSegmentAfterCursor(state?.version === 1 && (state.segmentAfterCursor === null || typeof state.segmentAfterCursor === 'string' && state.segmentAfterCursor.length <= 500) ? state.segmentAfterCursor : null)
      setSegmentComplete(state?.version === 1 && state.segmentComplete === true)
      setSegmentActive(state?.version === 1 && state.segmentActive === true)
    } catch {
      setScanCursor(null)
      setScanComplete(false)
      setCandidateBacklog([])
      setPendingUnits([])
      setSegmentAfterCursor(null)
      setSegmentComplete(false)
      setSegmentActive(false)
    } finally {
      setScanStateReady(true)
    }
  }, [scanStateKey])

  useEffect(() => {
    if (!scanStateReady || !scanStateKey) return
    const state: QueueScanState = {
      version: 1, cursor: scanCursor, complete: scanComplete, backlog: candidateBacklog,
      pendingUnits, segmentAfterCursor, segmentComplete, segmentActive,
    }
    try {
      sessionStorage.setItem(scanStateKey, JSON.stringify(state))
    } catch {
      setError('This browser could not save the scan checkpoint. Keep this tab open until the current project scan finishes.')
    }
  }, [scanCursor, scanComplete, candidateBacklog, pendingUnits, segmentAfterCursor, segmentComplete, segmentActive, scanStateKey, scanStateReady])

  const queueQuery = useQuery({
    queryKey: ['reamon-project-function-agent-queue', projectId, taskId],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ taskId: taskId as string })
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate/batches?${params}`, { signal, cache: 'no-store' })
      if (!response.ok) throw new Error(await responseError(response, 'Could not load the saved function queue'))
      return response.json() as Promise<QueueResponse>
    },
    enabled: Boolean(taskId),
    staleTime: 0,
    refetchInterval: (query) => query.state.data?.batch?.attempts.some((attempt) => attempt.status === 'QUEUED' || attempt.status === 'RUNNING') ? 2000 : false,
  })

  const attempts = queueQuery.data?.batch?.attempts ?? EMPTY_ATTEMPTS
  const counts = useMemo(() => ({
    ready: attempts.filter((attempt) => attempt.status === 'SUCCEEDED').length,
    active: attempts.filter((attempt) => attempt.status === 'QUEUED' || attempt.status === 'RUNNING').length,
  }), [attempts])

  async function runQueue() {
    if (!taskId || !providerId || !scanStateReady || starting || counts.active > 0 || (scanComplete && candidateBacklog.length === 0)) return
    setStarting(true)
    setMessage(candidateBacklog.length ? `Queueing the next functions (${candidateBacklog.length} remain in this scan batch)…` : 'Looking for functions across source files…')
    setError('')
    try {
      let nextCursor = scanCursor
      let nextComplete = scanComplete
      let nextPendingUnits = pendingUnits
      let nextSegmentAfterCursor = segmentAfterCursor
      let nextSegmentComplete = segmentComplete
      let nextSegmentActive = segmentActive
      let selected: QueueCandidate[]
      let remainingCandidates: QueueCandidate[]

      if (candidateBacklog.length) {
        selected = candidateBacklog.slice(0, MAX_FUNCTIONS)
        remainingCandidates = candidateBacklog.slice(selected.length)
      } else {
        if (!nextPendingUnits.length && nextSegmentActive) {
          nextCursor = nextSegmentAfterCursor
          nextComplete = nextSegmentComplete
          nextSegmentAfterCursor = null
          nextSegmentComplete = false
          nextSegmentActive = false
        }
        if (!nextPendingUnits.length && nextComplete) {
          setScanCursor(nextCursor)
          setScanComplete(true)
          setSegmentAfterCursor(null)
          setSegmentComplete(false)
          setSegmentActive(false)
          setMessage('The scan reached the end of this run; no editable functions remain.')
          return
        }

        if (!nextPendingUnits.length && !nextComplete) {
          const sourceUnits: CodeUnit[] = []
          const seen = new Set<string>()
          let cursor: string | null = nextCursor
          let pageCount = 0
          let reachedEnd = false
          while (sourceUnits.length < MAX_SOURCE_UNITS_TO_SCAN && pageCount < 4 && !reachedEnd) {
            const page = await fetchCodeUnitPage(projectId, taskId, cursor)
            let stoppedAtUnitLimit = false
            for (const unit of page.units) {
              if (!unit.codeArtifactId || !unit.artifactId || !unit.language?.trim() || unit.unitType === 'resource'
                  || unit.maintainedSource || unit.sizeBytes > MAX_OUTLINE_SOURCE_BYTES || seen.has(unit.id)) continue
              seen.add(unit.id)
              sourceUnits.push(unit)
              if (sourceUnits.length >= MAX_SOURCE_UNITS_TO_SCAN) {
                cursor = unit.id
                stoppedAtUnitLimit = true
                break
              }
            }
            pageCount += 1
            if (stoppedAtUnitLimit) break
            if (page.hasMore && page.nextCursor) cursor = page.nextCursor
            else {
              cursor = null
              reachedEnd = true
            }
          }
          nextSegmentAfterCursor = cursor
          nextSegmentComplete = reachedEnd
          nextPendingUnits = sourceUnits.map((unit) => ({
            id: unit.id,
            name: (unit.name || 'Source file').slice(0, 500),
            language: (unit.language || 'unknown').slice(0, 80),
            memberOffset: 0,
          }))
          nextSegmentActive = nextPendingUnits.length > 0
          if (!sourceUnits.length) {
            nextCursor = nextSegmentAfterCursor
            nextComplete = nextSegmentComplete
            nextSegmentAfterCursor = null
            nextSegmentComplete = false
            setScanCursor(nextCursor)
            setScanComplete(nextComplete)
            setPendingUnits([])
            setSegmentAfterCursor(null)
            setSegmentComplete(false)
            setSegmentActive(false)
            setMessage(nextComplete
              ? 'The scan reached the end of this run; no unreviewed source files remain.'
              : 'No eligible source files in this segment. Run the queue again to scan the next segment.')
            return
          }
        }

        const outlines = new Map<string, MemberOutline[]>()
        const outlineErrors: string[] = []
        const updatedPendingUnits: QueueSourceUnit[] = []
        for (let index = 0; index < nextPendingUnits.length; index += 3) {
          const group = nextPendingUnits.slice(index, index + 3)
          const results = await Promise.allSettled(group.map(async (unit) => ({ unit, members: await fetchOutline(projectId, unit) })))
          for (const [resultIndex, result] of results.entries()) {
            if (result.status === 'rejected') {
              updatedPendingUnits.push(group[resultIndex])
              if (outlineErrors.length < 3) outlineErrors.push(result.reason instanceof Error ? result.reason.message : 'A source outline could not be read')
              continue
            }
            outlines.set(result.value.unit.id, result.value.members)
          }
          setMessage(`Checked ${Math.min(index + group.length, nextPendingUnits.length)} of ${nextPendingUnits.length} source files…`)
        }

        const candidateGroups: QueueCandidate[][] = []
        for (const unit of nextPendingUnits) {
          const members = (outlines.get(unit.id) || [])
            .filter((member) => member.name.trim() && member.start_byte >= 0 && member.end_byte > member.start_byte
              && member.source_bytes > 0 && member.source_bytes <= MAX_MEMBER_REWRITE_BYTES)
            .sort((left, right) => left.start_byte - right.start_byte)
            .filter((member, index, sorted) => index === 0 || member.start_byte >= sorted[index - 1].end_byte)
          const offset = unit.memberOffset
          const pageMembers = members.slice(offset, offset + 10)
          if (offset + pageMembers.length < members.length) {
            updatedPendingUnits.push({ ...unit, memberOffset: offset + pageMembers.length })
          }
          candidateGroups.push(pageMembers.map((member) => ({
            unit: { id: unit.id, name: unit.name, language: unit.language },
            member,
          })))
        }
        const candidates: QueueCandidate[] = []
        for (let memberIndex = 0; memberIndex < 10; memberIndex += 1) {
          for (const group of candidateGroups) {
            const candidate = group[memberIndex]
            if (candidate) candidates.push(candidate)
          }
        }
        if (outlineErrors.length && !candidates.length) {
          setPendingUnits(updatedPendingUnits)
          setSegmentAfterCursor(nextSegmentAfterCursor)
          setSegmentComplete(nextSegmentComplete)
          setSegmentActive(nextSegmentActive)
          throw new Error(`No functions were found in this segment. ${outlineErrors[0]}`)
        }
        if (!candidates.length) {
          if (updatedPendingUnits.length) {
            setPendingUnits(updatedPendingUnits)
            setSegmentAfterCursor(nextSegmentAfterCursor)
            setSegmentComplete(nextSegmentComplete)
            setSegmentActive(nextSegmentActive)
            setError(outlineErrors.slice(0, 3).join(' '))
            return
          }
          nextCursor = nextSegmentAfterCursor
          nextComplete = nextSegmentComplete
          nextSegmentAfterCursor = null
          nextSegmentComplete = false
          nextSegmentActive = false
          setScanCursor(nextCursor)
          setScanComplete(nextComplete)
          setPendingUnits([])
          setSegmentAfterCursor(null)
          setSegmentComplete(false)
          setSegmentActive(false)
          setMessage(nextComplete
            ? 'The scan reached the end of this run; no editable functions remain.'
            : 'No editable functions in this segment. Run the queue again to scan the next segment.')
          return
        }
        nextPendingUnits = updatedPendingUnits
        selected = candidates.slice(0, MAX_FUNCTIONS)
        remainingCandidates = candidates.slice(selected.length)
      }

      const batchId = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
      setMessage(`Queueing ${selected.length} function${selected.length === 1 ? '' : 's'} from ${new Set(selected.map((item) => item.unit.id)).size} source files…`)
      const queued = await Promise.allSettled(selected.map(async ({ unit, member }) => {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            unitId: unit.id,
            providerId,
            ...(reviewerProviderId ? { reviewerProviderId } : {}),
            scope: 'member',
            startByte: member.start_byte,
            endByte: member.end_byte,
            memberName: member.name,
            agentBatchId: batchId,
          }),
        })
        if (!response.ok) throw new Error(`${member.name}: ${await responseError(response, 'Could not queue function rewrite')}`)
      }))
      const failures = queued.flatMap((result) => result.status === 'rejected'
        ? [result.reason instanceof Error ? result.reason.message : 'Could not queue function rewrite'] : [])
      const successCount = queued.length - failures.length
      const failedCandidates = queued.flatMap((result, index) => result.status === 'rejected' ? [selected[index]] : [])
      if (successCount === 0) {
        setCandidateBacklog([...selected, ...remainingCandidates])
        setScanCursor(nextCursor)
        setScanComplete(nextComplete)
        setPendingUnits(nextPendingUnits)
        setSegmentAfterCursor(nextSegmentAfterCursor)
        setSegmentComplete(nextSegmentComplete)
        setSegmentActive(nextSegmentActive)
        throw new Error(failures.slice(0, 3).join(' '))
      }
      setCandidateBacklog([...remainingCandidates, ...failedCandidates])
      setScanCursor(nextCursor)
      setScanComplete(nextComplete)
      setPendingUnits(nextPendingUnits)
      setSegmentAfterCursor(nextSegmentAfterCursor)
      setSegmentComplete(nextSegmentComplete)
      setSegmentActive(nextSegmentActive)
      setMessage(`${successCount} function${successCount === 1 ? '' : 's'} queued from ${new Set(selected.map((item) => item.unit.id)).size} source files.${remainingCandidates.length + failedCandidates.length ? ` ${remainingCandidates.length + failedCandidates.length} more functions remain in this segment.` : nextPendingUnits.length ? ' More functions remain in these files.' : nextComplete ? ' The run scan is complete.' : ' Run again to scan the next segment.'} Results stay separate until reviewed in each file.`)
      if (failures.length) setError(failures.slice(0, 3).join(' '))
      await queryClient.invalidateQueries({ queryKey: ['reamon-project-function-agent-queue', projectId, taskId] })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the project function queue')
    } finally {
      setStarting(false)
    }
  }

  async function cancelQueue() {
    const batchId = queueQuery.data?.batch?.id
    if (!batchId || cancelling) return
    setCancelling(true)
    setError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/deobfuscate/batches/${encodeURIComponent(batchId)}/cancel`, { method: 'POST' })
      if (!response.ok) throw new Error(await responseError(response, 'Could not cancel the function queue'))
      await queryClient.invalidateQueries({ queryKey: ['reamon-project-function-agent-queue', projectId, taskId] })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not cancel the function queue')
    } finally {
      setCancelling(false)
    }
  }

  if (!taskId) return null
  return <section className={styles.panel} aria-label="Project function agent queue">
    <div className={styles.heading}>
      <div>
        <strong>Reverse engineer functions across this run</strong>
        <p>Scan up to 40 source files per batch and queue up to 10 functions. Re-run the queue to work through the whole analysis; each result stays attached to its file for review and acceptance.</p>
      </div>
      <button type="button" disabled={!providerId || !scanStateReady || starting || counts.active > 0 || queueQuery.isLoading || (scanComplete && candidateBacklog.length === 0)} onClick={() => void runQueue()}>
        {starting ? 'Finding functions…' : counts.active > 0 ? 'Agents working…' : scanComplete && candidateBacklog.length === 0 ? 'Run scan complete' : candidateBacklog.length ? 'Queue remaining functions' : pendingUnits.length || segmentActive ? 'Continue current scan' : 'Scan next project batch'}
      </button>
    </div>
    {!providerId && <p className={styles.message}>Add an OpenAI-compatible provider in Settings to run function agents.</p>}
    {queueQuery.isLoading && <p role="status">Loading saved queue…</p>}
    {queueQuery.isError && <p className={styles.error} role="alert">{queueQuery.error instanceof Error ? queueQuery.error.message : 'Could not load the saved function queue.'}</p>}
    {message && <p role="status">{message}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {queueQuery.data?.batch && <div className={styles.batch} aria-live="polite">
      <div className={styles.batchHeading}>
        <strong>{counts.ready} of {attempts.length} functions ready for review</strong>
        <span>{counts.active ? `${counts.active} queued or running` : `Batch ${queueQuery.data.batch.id.slice(-10)}`}</span>
      </div>
      <ol>
        {attempts.map((attempt) => <li key={attempt.id}>
          <span><strong>{attempt.memberName}</strong> · {attempt.unitName} · {attempt.language}</span>
          <span className={styles.status}>{attempt.cancelRequested && attempt.status === 'RUNNING' ? 'Cancellation requested' : attempt.status.toLowerCase()}{attempt.validationStatus ? ` · ${attempt.validationStatus.toLowerCase()}` : ''}</span>
          <a href={`/projects/${encodeURIComponent(projectId)}/visualizer?taskId=${encodeURIComponent(taskId)}&unitId=${encodeURIComponent(attempt.codeUnitId)}`}>Open file for review</a>
          {attempt.errorMessage && <small>{attempt.errorMessage}</small>}
        </li>)}
      </ol>
      {counts.active > 0 && <button className={styles.cancel} type="button" disabled={cancelling} onClick={() => void cancelQueue()}>{cancelling ? 'Cancelling…' : 'Cancel queued functions'}</button>}
    </div>}
  </section>
}

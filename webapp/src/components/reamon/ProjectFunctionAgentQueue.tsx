'use client'

import { useMemo, useState } from 'react'
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

interface QueueCandidate {
  unit: CodeUnit
  member: MemberOutline
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

async function fetchOutline(projectId: string, unit: CodeUnit): Promise<MemberOutline[]> {
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

  const attempts = queueQuery.data?.batch?.attempts || []
  const counts = useMemo(() => ({
    ready: attempts.filter((attempt) => attempt.status === 'SUCCEEDED').length,
    active: attempts.filter((attempt) => attempt.status === 'QUEUED' || attempt.status === 'RUNNING').length,
  }), [attempts])

  async function runQueue() {
    if (!taskId || !providerId || starting || counts.active > 0) return
    setStarting(true)
    setMessage('Looking for functions across source files…')
    setError('')
    try {
      const sourceUnits: CodeUnit[] = []
      const seen = new Set<string>()
      let cursor: string | null = null
      let pageCount = 0
      while (sourceUnits.length < MAX_SOURCE_UNITS_TO_SCAN && pageCount < 4) {
        const page = await fetchCodeUnitPage(projectId, taskId, cursor)
        for (const unit of page.units) {
          if (!unit.codeArtifactId || !unit.artifactId || !unit.language?.trim() || unit.unitType === 'resource'
              || unit.maintainedSource || unit.draftSource || unit.sizeBytes > MAX_OUTLINE_SOURCE_BYTES || seen.has(unit.id)) continue
          seen.add(unit.id)
          sourceUnits.push(unit)
          if (sourceUnits.length >= MAX_SOURCE_UNITS_TO_SCAN) break
        }
        pageCount += 1
        if (!page.hasMore || !page.nextCursor) break
        cursor = page.nextCursor
      }
      if (!sourceUnits.length) throw new Error('No unreviewed, source-linked code units were found in the first four run pages.')

      const outlines = new Map<string, MemberOutline[]>()
      const outlineErrors: string[] = []
      for (let index = 0; index < sourceUnits.length; index += 3) {
        const group = sourceUnits.slice(index, index + 3)
        const results = await Promise.allSettled(group.map(async (unit) => ({ unit, members: await fetchOutline(projectId, unit) })))
        for (const result of results) {
          if (result.status === 'fulfilled') outlines.set(result.value.unit.id, result.value.members)
          else if (outlineErrors.length < 3) outlineErrors.push(result.reason instanceof Error ? result.reason.message : 'A source outline could not be read')
        }
        setMessage(`Checked ${Math.min(index + group.length, sourceUnits.length)} of ${sourceUnits.length} source files…`)
      }

      const membersByUnit = sourceUnits.map((unit) => ({
        unit,
        members: (outlines.get(unit.id) || [])
          .filter((member) => member.name.trim() && member.start_byte >= 0 && member.end_byte > member.start_byte
            && member.source_bytes > 0 && member.source_bytes <= MAX_MEMBER_REWRITE_BYTES)
          .sort((left, right) => left.start_byte - right.start_byte)
          .filter((member, index, members) => index === 0 || member.start_byte >= members[index - 1].end_byte),
      })).filter((entry) => entry.members.length > 0)

      const selected: QueueCandidate[] = []
      for (let memberIndex = 0; memberIndex < 10 && selected.length < MAX_FUNCTIONS; memberIndex += 1) {
        for (const entry of membersByUnit) {
          const member = entry.members[memberIndex]
          if (!member) continue
          selected.push({ unit: entry.unit, member })
          if (selected.length >= MAX_FUNCTIONS) break
        }
      }
      if (!selected.length) {
        throw new Error(outlineErrors.length
          ? `No eligible functions were found. ${outlineErrors[0]}`
          : 'No editable functions under 64 KiB were found in the scanned source files.')
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
      if (successCount === 0) throw new Error(failures.slice(0, 3).join(' '))
      setMessage(`${successCount} function${successCount === 1 ? '' : 's'} queued from ${new Set(selected.map((item) => item.unit.id)).size} source files. Results stay separate until reviewed in each file.`)
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
        <p>Scan up to 40 source files and queue up to 10 functions. Each result stays attached to its file for separate review and acceptance.</p>
      </div>
      <button type="button" disabled={!providerId || starting || counts.active > 0 || queueQuery.isLoading} onClick={() => void runQueue()}>
        {starting ? 'Finding functions…' : counts.active > 0 ? 'Agents working…' : 'Run project function queue'}
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

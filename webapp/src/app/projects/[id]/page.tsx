'use client'

import { use, useMemo, useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, CircleDashed, FileArchive, FileCode2, FileQuestion, Gauge, Upload, Waypoints } from 'lucide-react'
import type { CapabilityMatch, ProgressMetric, TargetProfile } from '@/lib/reamon'
import styles from './page.module.css'

interface WorkspaceSnapshot {
  workspace: { id: string; name: string; description: string | null; createdAt: string; updatedAt: string }
  targets: Array<{ id: string; name: string; targetType: string; status: string; profile: TargetProfile }>
  artifacts: Array<{
    id: string
    name: string
    originalName: string
    targetId: string | null
    sizeBytes: number
    sha256: string
    mimeType: string
    extension: string
    status: string
    profile: TargetProfile
    capabilities: CapabilityMatch[]
    createdAt: string
    updatedAt: string
  }>
  tasks: Array<{ id: string; title: string; category: string; status: string; progress: number }>
  findings: Array<{ id: string; title: string; severity: string; status: string }>
  hypotheses: Array<{ id: string; statement: string; status: string }>
  evidence: Array<{ id: string; summary: string; source: string; createdAt: string }>
  activities: Array<{ id: string; actor: string; eventType: string; message: string; createdAt: string }>
  progress: { overallPercent: number; metrics: ProgressMetric[] }
  counts: { targets: number; artifacts: number; tasks: number; findings: number; hypotheses: number; evidence: number }
}

async function fetchWorkspace(projectId: string): Promise<WorkspaceSnapshot> {
  const response = await fetch(`/api/projects/${projectId}/workspace`)
  if (!response.ok) throw new Error('Unable to load workspace')
  return response.json()
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function profileLabel(profile: TargetProfile): string {
  const details = [profile.format.toUpperCase()]
  if (profile.architecture) details.push(profile.architecture)
  if (profile.platform) details.push(profile.platform)
  return details.join(' · ')
}

function ProfileIcon({ format }: { format: string }) {
  if (format === 'source') return <FileCode2 size={18} />
  if (['zip', 'apk', 'jar'].includes(format)) return <FileArchive size={18} />
  if (format === 'unknown') return <FileQuestion size={18} />
  return <Waypoints size={18} />
}

function ProgressBar({ metric }: { metric: ProgressMetric }) {
  return (
    <div className={styles.metric}>
      <div className={styles.metricHeader}>
        <span>{metric.label}</span>
        <span>{metric.percent}%</span>
      </div>
      <div className={styles.track} aria-label={`${metric.label}: ${metric.percent}%`}>
        <div className={styles.fill} style={{ width: `${metric.percent}%` }} />
      </div>
    </div>
  )
}

function CapabilityList({ capabilities }: { capabilities: CapabilityMatch[] }) {
  if (!capabilities.length) return <span className={styles.muted}>No compatible providers yet</span>
  const names = [...new Set(capabilities.flatMap((match) => match.capabilities))]
  return (
    <div className={styles.capabilityList}>
      {names.map((capability) => (
        <span key={capability} className={styles.capability}>
          {capability.replaceAll('_', ' ')}
        </span>
      ))}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  )
}

export default function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = use(params)
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [targetName, setTargetName] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)

  const workspace = useQuery({
    queryKey: ['reamon-workspace', projectId],
    queryFn: () => fetchWorkspace(projectId),
  })

  const importTarget = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose a file first')
      const body = new FormData()
      body.set('file', file)
      if (targetName.trim()) body.set('targetName', targetName.trim())
      const response = await fetch(`/api/projects/${projectId}/targets`, { method: 'POST', body })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to import target')
      return data
    },
    onSuccess: () => {
      setFile(null)
      setTargetName('')
      setUploadError(null)
      void queryClient.invalidateQueries({ queryKey: ['reamon-workspace', projectId] })
    },
    onError: (error) => setUploadError(error instanceof Error ? error.message : 'Failed to import target'),
  })

  const allCapabilities = useMemo(() => {
    const map = new Map<string, { name: string; count: number }>()
    for (const artifact of workspace.data?.artifacts || []) {
      for (const match of artifact.capabilities) {
        const current = map.get(match.pluginId)
        map.set(match.pluginId, { name: match.pluginName, count: (current?.count || 0) + 1 })
      }
    }
    return [...map.entries()].map(([id, provider]) => ({ id, ...provider }))
  }, [workspace.data?.artifacts])

  if (workspace.isLoading) {
    return <div className={styles.loading}>Loading workspace…</div>
  }
  if (workspace.isError || !workspace.data) {
    return <div className={styles.error}>Unable to load this workspace. Check that it still exists.</div>
  }

  const data = workspace.data
  return (
    <div className={styles.page}>
      <div className={styles.topbar}>
        <Link href="/projects" className={styles.backLink}><ArrowLeft size={15} /> Projects</Link>
        <Link href={`/projects/${data.workspace.id}/settings`} className="secondaryButton">Workspace settings</Link>
      </div>

      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Reverse-engineering workspace</p>
          <h1>{data.workspace.name}</h1>
          <p className={styles.description}>{data.workspace.description || 'Analyse anything. Connect the evidence. Understand the system.'}</p>
        </div>
        <div className={styles.progressSummary} aria-label={`Workspace progress: ${data.progress.overallPercent}%`}>
          <Gauge size={17} />
          <strong>{data.progress.overallPercent}%</strong>
          <span>progress</span>
        </div>
      </header>

      <div className={styles.stats}>
        <Stat label="Targets" value={data.counts.targets} />
        <Stat label="Artifacts" value={data.counts.artifacts} />
        <Stat label="Tasks" value={data.counts.tasks} />
        <Stat label="Findings" value={data.counts.findings} />
        <Stat label="Hypotheses" value={data.counts.hypotheses} />
        <Stat label="Evidence" value={data.counts.evidence} />
      </div>

      <section className={styles.importPanel} aria-labelledby="import-heading">
        <div>
          <p className={styles.sectionKicker}>Start an investigation</p>
          <h2 id="import-heading">Import an arbitrary target</h2>
          <p className={styles.muted}>REAmon profiles the bytes it can identify and keeps unknown inputs valid for later analysis.</p>
        </div>
        <div className={styles.importControls}>
          <label className={styles.filePicker}>
            <Upload size={16} />
            <span>{file?.name || 'Choose a file'}</span>
            <input type="file" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          </label>
          <input className="textInput" value={targetName} onChange={(event) => setTargetName(event.target.value)} placeholder="Target name (optional)" />
          <button className="primaryButton" onClick={() => importTarget.mutate()} disabled={!file || importTarget.isPending}>
            {importTarget.isPending ? 'Profiling…' : 'Import and profile'}
          </button>
        </div>
        {uploadError && <p className={styles.uploadError}>{uploadError}</p>}
      </section>

      <div className={styles.grid}>
        <section className={styles.panel} aria-labelledby="progress-heading">
          <div className={styles.panelHeader}><h2 id="progress-heading">Progress</h2><span className={styles.muted}>Deterministic lifecycle state</span></div>
          {data.progress.metrics.length ? data.progress.metrics.map((metric) => <ProgressBar key={metric.id} metric={metric} />) : <p className={styles.muted}>Progress appears as investigation entities are created.</p>}
        </section>

        <section className={styles.panel} aria-labelledby="providers-heading">
          <div className={styles.panelHeader}><h2 id="providers-heading">Available capabilities</h2><span className={styles.muted}>{allCapabilities.length} provider{allCapabilities.length === 1 ? '' : 's'}</span></div>
          {allCapabilities.length ? allCapabilities.map((provider) => (
            <div className={styles.providerRow} key={provider.id}><span>{provider.name}</span><span className={styles.providerCount}>{provider.count} artifact{provider.count === 1 ? '' : 's'}</span></div>
          )) : <p className={styles.muted}>Import a target to resolve compatible analysis providers.</p>}
        </section>
      </div>

      <section className={styles.panel} aria-labelledby="targets-heading">
        <div className={styles.panelHeader}><h2 id="targets-heading">Targets and artifacts</h2><span className={styles.muted}>{data.targets.length} target{data.targets.length === 1 ? '' : 's'}</span></div>
        {data.targets.length ? data.targets.map((target) => (
          <div className={styles.targetBlock} key={target.id}>
            <div className={styles.targetHeader}>
              <div className={styles.targetTitle}><Waypoints size={17} /><strong>{target.name}</strong><span className={styles.type}>{target.targetType}</span></div>
              <span className={styles.status}><CheckCircle2 size={14} /> {target.status}</span>
            </div>
            <div className={styles.artifactList}>
              {data.artifacts.filter((artifact) => artifact.targetId === target.id).map((artifact) => (
                <div className={styles.artifactRow} key={artifact.id}>
                  <ProfileIcon format={artifact.profile.format} />
                  <div className={styles.artifactIdentity}><strong>{artifact.originalName}</strong><span>{profileLabel(artifact.profile)} · {formatBytes(artifact.sizeBytes)} · sha256 {artifact.sha256.slice(0, 12)}…</span></div>
                  <CapabilityList capabilities={artifact.capabilities} />
                </div>
              ))}
            </div>
          </div>
        )) : <div className={styles.empty}><CircleDashed size={25} /><span>No targets imported yet.</span></div>}
      </section>

      <div className={styles.bottomGrid}>
        <section className={styles.panel} aria-labelledby="work-heading">
          <div className={styles.panelHeader}><h2 id="work-heading">Tasks and findings</h2></div>
          {!data.tasks.length && !data.findings.length ? <p className={styles.muted}>No analysis work has been scheduled.</p> : <>{data.tasks.map((task) => <div className={styles.listRow} key={task.id}><span>{task.title}</span><span className={styles.type}>{task.status} · {task.progress}%</span></div>)}{data.findings.map((finding) => <div className={styles.listRow} key={finding.id}><span>{finding.title}</span><span className={styles.type}>{finding.severity} · {finding.status}</span></div>)}</>}
        </section>
        <section className={styles.panel} aria-labelledby="hypotheses-heading">
          <div className={styles.panelHeader}><h2 id="hypotheses-heading">Hypotheses</h2></div>
          {data.hypotheses.length ? data.hypotheses.map((hypothesis) => <div className={styles.listRow} key={hypothesis.id}><span>{hypothesis.statement}</span><span className={styles.type}>{hypothesis.status}</span></div>) : <p className={styles.muted}>No hypotheses recorded.</p>}
        </section>
        <section className={styles.panel} aria-labelledby="activity-heading">
          <div className={styles.panelHeader}><h2 id="activity-heading">Recent activity</h2></div>
          {data.activities.length ? data.activities.map((activity) => <div className={styles.activityRow} key={activity.id}><span className={styles.activityDot} /><div><strong>{activity.actor}</strong><p>{activity.message}</p><time>{new Date(activity.createdAt).toLocaleString()}</time></div></div>) : <p className={styles.muted}>Activity will appear as the workspace changes.</p>}
        </section>
      </div>
    </div>
  )
}

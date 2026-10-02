'use client'

import { use, useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleDashed, Gauge, Server, Waypoints } from 'lucide-react'
import { WorkspaceFileTree } from '@/components/reamon/WorkspaceFileTree'
import { WorkspaceImportPanel } from '@/components/reamon/WorkspaceImportPanel'
import { WorkspaceAnalysisPlanPanel, type WorkspaceAnalysisPlan } from '@/components/reamon/WorkspaceAnalysisPlan'
import { WorkspaceTaskList } from '@/components/reamon/WorkspaceTaskList'
import type { CapabilityMatch, ProgressMetric, TargetProfile, WorkspaceCapabilitySummary, WorkspaceImportSnapshot, WorkspaceObservation, WorkspaceProfile } from '@/lib/reamon'
import styles from './page.module.css'

type WorkerHealth = { workerId: string; status: string; lastSeenAt: string; lastDispatchAt: string | null; lastDispatchDurationMs: number | null; lastRecovered: number; lastSelected: number; lastCompleted: number; lastFailed: number; lastError: string }

interface WorkspaceSnapshot {
  workspace: { id: string; name: string; description: string | null; createdAt: string; updatedAt: string }
  targets: Array<{ id: string; name: string; targetType: string; status: string; parentTargetId: string | null; profile: TargetProfile }>
  artifacts: Array<{
    id: string
    name: string
    originalName: string
    targetId: string | null
    importId: string | null
    relativePath: string
    parentPath: string
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
  tasks: Array<{ id: string; title: string; category: string; status: string; progress: number; error: string; leaseOwner: string | null; leaseHeartbeatAt: string | null }>
  findings: Array<{ id: string; title: string; severity: string; status: string }>
  hypotheses: Array<{ id: string; statement: string; status: string }>
  evidence: Array<{ id: string; summary: string; source: string; createdAt: string }>
  observations: WorkspaceObservation[]
  projectionRuns: Array<{ projectionRunId: string; status: string; offset: number; selected: number; nodes: number; relationships: number; truncated: boolean; error: string; startedAt: string; completedAt: string | null }>
  activities: Array<{ id: string; actor: string; eventType: string; message: string; createdAt: string }>
  capabilities: WorkspaceCapabilitySummary[]
  imports: WorkspaceImportSnapshot[]
  artifactPage: { limit: number; total: number; hasMore: boolean }
  progress: { overallPercent: number; metrics: ProgressMetric[] }
  counts: { targets: number; artifacts: number; tasks: number; findings: number; hypotheses: number; evidence: number; observations: number }
  workers: WorkerHealth[]
}

async function fetchWorkspace(projectId: string): Promise<WorkspaceSnapshot> {
  const response = await fetch(`/api/projects/${projectId}/workspace`)
  if (!response.ok) throw new Error('Unable to load workspace')
  return response.json()
}

async function fetchAnalysisPlan(projectId: string): Promise<WorkspaceAnalysisPlan> {
  const response = await fetch(`/api/projects/${projectId}/workspace/analysis-plan?limit=100`)
  if (!response.ok) throw new Error('Unable to load analysis proposals')
  return response.json()
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function profileLabel(profile: TargetProfile): string {
  const details = [profile.format.toUpperCase()]
  if (profile.architecture) details.push(profile.architecture)
  if (profile.platform) details.push(profile.platform)
  return details.join(' · ')
}

function observationTitle(observation: WorkspaceObservation): string {
  if (observation.kind === 'relationship' && observation.fromKey && observation.toKey) {
    return `${observation.fromKey} ${observation.relation || observation.type} ${observation.toKey}`
  }
  return observation.label || observation.key
}

function ProgressBar({ metric }: { metric: ProgressMetric }) {
  return (
    <div className={styles.metric}>
      <div className={styles.metricHeader}><span>{metric.label}</span><span>{metric.percent}%</span></div>
      <div className={styles.track} aria-label={`${metric.label}: ${metric.percent}%`}><div className={styles.fill} style={{ width: `${metric.percent}%` }} /></div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className={styles.stat}><span className={styles.statValue}>{value.toLocaleString()}</span><span className={styles.statLabel}>{label}</span></div>
}

function WorkspaceProfileCard({ profile }: { profile: WorkspaceProfile | null }) {
  if (!profile) return <p className={styles.muted}>Import a folder to build the workspace inventory.</p>
  return (
    <div className={styles.profileGrid}>
      <div><strong>{profile.fileCount.toLocaleString()}</strong><span>Files</span></div>
      <div><strong>{profile.directoryCount.toLocaleString()}</strong><span>Directories</span></div>
      <div><strong>{formatBytes(profile.totalBytes)}</strong><span>Total size</span></div>
      <div><strong>{profile.interestingArtifacts.toLocaleString()}</strong><span>Interesting artifacts</span></div>
      <div><strong>{profile.sourceFileCount.toLocaleString()}</strong><span>Source files</span></div>
      <div><strong>{profile.configurationFileCount.toLocaleString()}</strong><span>Configuration</span></div>
      <div className={styles.profileWide}><span>Detected platforms</span><strong>{profile.detectedPlatforms.length ? profile.detectedPlatforms.join(' · ') : 'Not identified yet'}</strong></div>
      <div className={styles.profileWide}><span>Potential entrypoints</span><strong>{profile.potentialEntrypoints.length ? profile.potentialEntrypoints.join(', ') : 'None identified yet'}</strong></div>
    </div>
  )
}

function ImportStatus({ latestImport }: { latestImport: WorkspaceImportSnapshot | undefined }) {
  if (!latestImport) return null
  const percent = latestImport.totalBytes ? Math.round((latestImport.uploadedBytes / latestImport.totalBytes) * 100) : latestImport.totalFiles ? Math.round((latestImport.completedFiles / latestImport.totalFiles) * 100) : 0
  return (
    <div className={styles.importStatus} aria-live="polite">
      <div className={styles.panelHeader}><h2>Latest import</h2><span className={styles.type}>{latestImport.status}</span></div>
      <div className={styles.importStatusGrid}><span>Root</span><strong>{latestImport.rootName}</strong><span>Inventory</span><strong>{latestImport.totalFiles.toLocaleString()} files · {formatBytes(latestImport.totalBytes)}</strong><span>Uploaded</span><strong>{latestImport.completedFiles.toLocaleString()} / {latestImport.totalFiles.toLocaleString()} files · {percent}%</strong><span>Profile</span><strong>{latestImport.profile?.interestingArtifacts ?? 0} interesting artifacts</strong></div>
      {latestImport.comparison && <p className={styles.muted}>{latestImport.comparison.mode === 'HASH' ? 'Authoritative refresh' : 'Manifest refresh'}: +{latestImport.comparison.addedCount} added · {latestImport.comparison.changedCount} changed · {latestImport.comparison.removedCount} removed · {latestImport.comparison.unchangedCount} unchanged.</p>}
      {latestImport.missingPaths.length > 0 && <p className={styles.uploadError}>{latestImport.missingPaths.length} file paths still need upload. Retry the import to resume.</p>}
      {latestImport.errorSummary && <p className={styles.uploadError}>{latestImport.errorSummary}</p>}
    </div>
  )
}

function WorkerHealthAlert({ workers }: { workers: WorkerHealth[] }) {
  const attention = workers.filter((worker) => worker.status === 'STALE' || worker.status === 'DEGRADED')
  if (!attention.length) return null

  const degraded = attention.filter((worker) => worker.status === 'DEGRADED').length
  const names = attention.slice(0, 3).map((worker) => worker.workerId).join(', ')
  const remainder = attention.length > 3 ? ` and ${attention.length - 3} more` : ''
  return (
    <aside className={styles.workerAlert} role="alert" aria-labelledby="worker-alert-heading">
      <AlertTriangle size={19} aria-hidden="true" />
      <div>
        <strong id="worker-alert-heading">Analysis worker attention required</strong>
        <p>{degraded ? `${degraded} worker${degraded === 1 ? '' : 's'} reported a failed dispatch. ` : ''}{attention.length - degraded ? `${attention.length - degraded} worker${attention.length - degraded === 1 ? '' : 's'} are stale. ` : ''}Affected: {names}{remainder}.</p>
        <small>New analysis tasks may wait until the worker process recovers. Check the worker logs before retrying failed tasks.</small>
      </div>
    </aside>
  )
}

export default function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = use(params)
  const queryClient = useQueryClient()
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null)
  const workspace = useQuery({
    queryKey: ['reamon-workspace', projectId],
    queryFn: () => fetchWorkspace(projectId),
    refetchInterval: (query) => {
      const snapshot = query.state.data
      if (snapshot?.tasks.some((task) => task.status === 'RUNNING')) return 3000
      if (snapshot?.workers.length) return 30000
      return false
    },
    refetchIntervalInBackground: false,
  })
  const analysisPlan = useQuery({ queryKey: ['reamon-analysis-plan', projectId], queryFn: () => fetchAnalysisPlan(projectId) })

  const data = workspace.data
  const rootTarget = useMemo(() => data?.targets.find((target) => target.targetType === 'DIRECTORY'), [data?.targets])
  const latestImport = data?.imports[0]
  const logicalTargets = data?.targets.filter((target) => target.targetType !== 'DIRECTORY') || []
  const selectedLogicalTarget = logicalTargets.find((target) => target.id === selectedTarget)

  if (workspace.isLoading) return <div className={styles.loading}>Loading workspace…</div>
  if (workspace.isError || !data) return <div className={styles.error}>Unable to load this workspace. Check that it still exists.</div>

  return (
    <div className={styles.page}>
      <div className={styles.topbar}>
        <Link href="/projects" className={styles.backLink}><ArrowLeft size={15} /> Projects</Link>
        <Link href={`/projects/${data.workspace.id}/settings`} className="secondaryButton">Workspace settings</Link>
      </div>

      <header className={styles.hero}>
        <div><p className={styles.eyebrow}>Reverse-engineering workspace</p><h1>{data.workspace.name}</h1><p className={styles.description}>{data.workspace.description || 'Analyse anything. Connect the evidence. Understand the system.'}</p></div>
        <div className={styles.progressSummary} aria-label={`Workspace progress: ${data.progress.overallPercent}%`}><Gauge size={17} /><strong>{data.progress.overallPercent}%</strong><span>progress</span></div>
      </header>

      <WorkerHealthAlert workers={data.workers} />

      <div className={styles.stats}>
        <Stat label="Targets" value={data.counts.targets} /><Stat label="Artifacts" value={data.counts.artifacts} /><Stat label="Tasks" value={data.counts.tasks} /><Stat label="Findings" value={data.counts.findings} /><Stat label="Hypotheses" value={data.counts.hypotheses} /><Stat label="Evidence" value={data.counts.evidence} /><Stat label="Observations" value={data.counts.observations} />
      </div>

      <WorkspaceImportPanel projectId={projectId} onImported={() => {
        void queryClient.invalidateQueries({ queryKey: ['reamon-workspace', projectId] })
        void queryClient.invalidateQueries({ queryKey: ['reamon-analysis-plan', projectId] })
      }} />
      <ImportStatus latestImport={latestImport} />

      <section className={styles.panel} aria-labelledby="inventory-heading">
        <div className={styles.panelHeader}><h2 id="inventory-heading">Workspace inventory</h2><span className={styles.muted}>{rootTarget ? profileLabel(rootTarget.profile) : 'Awaiting import'}</span></div>
        <WorkspaceProfileCard profile={rootTarget?.profile.format === 'directory' ? rootTarget.profile as WorkspaceProfile : null} />
      </section>

      <div className={styles.grid}>
        <section className={styles.panel} aria-labelledby="progress-heading"><div className={styles.panelHeader}><h2 id="progress-heading">Progress</h2><span className={styles.muted}>Deterministic lifecycle state</span></div>{data.progress.metrics.length ? data.progress.metrics.map((metric) => <ProgressBar key={metric.id} metric={metric} />) : <p className={styles.muted}>Progress appears as investigation entities are created.</p>}</section>
        <section className={styles.panel} aria-labelledby="providers-heading"><div className={styles.panelHeader}><h2 id="providers-heading">Available capabilities</h2><span className={styles.muted}>{data.capabilities.length} provider{data.capabilities.length === 1 ? '' : 's'}</span></div>{data.capabilities.length ? data.capabilities.map((provider) => <div className={styles.providerRow} key={provider.pluginId}><span><strong>{provider.pluginName}</strong><small>{provider.capabilities.slice(0, 4).join(' · ')}</small><small>Accepts {provider.acceptsFormats.slice(0, 3).join(', ')} · produces {provider.produces.slice(0, 3).join(', ') || 'provider results'}</small></span><span className={styles.providerCount}>{provider.compatibleArtifactIds.length} compatible artifacts</span></div>) : <p className={styles.muted}>Capabilities will appear as providers are registered.</p>}</section>
      </div>

      <WorkspaceAnalysisPlanPanel projectId={projectId} plan={analysisPlan.data} isLoading={analysisPlan.isLoading} isError={analysisPlan.isError} onScheduled={() => {
        void queryClient.invalidateQueries({ queryKey: ['reamon-workspace', projectId] })
      }} />

      <section className={styles.panel} aria-labelledby="files-heading">
        <div className={styles.panelHeader}><h2 id="files-heading">Project files</h2><span className={styles.muted}>Relative paths are preserved as workspace context</span></div>
        <WorkspaceFileTree projectId={projectId} rootName={latestImport?.rootName || data.workspace.name} artifacts={data.artifacts} totalArtifacts={data.artifactPage.total} hasMoreArtifacts={data.artifactPage.hasMore} />
      </section>

      <section className={styles.panel} aria-labelledby="targets-heading">
        <div className={styles.panelHeader}><h2 id="targets-heading">Logical analysis targets</h2><span className={styles.muted}>{logicalTargets.length} detected</span></div>
        {logicalTargets.length ? <div className={styles.logicalTargets}>{logicalTargets.map((target) => <button type="button" key={target.id} className={`${styles.logicalTarget} ${selectedTarget === target.id ? styles.logicalTargetSelected : ''}`} onClick={() => setSelectedTarget(target.id)}><span><Waypoints size={16} /><strong>{target.name}</strong><small>{target.targetType} · {profileLabel(target.profile)}</small></span><span className={styles.status}><CheckCircle2 size={14} /> {target.status}</span></button>)}</div> : <div className={styles.empty}><CircleDashed size={25} /><span>Executable and library candidates will become logical targets after import.</span></div>}
        {selectedLogicalTarget && <div className={styles.targetNotice}>Selected target: <strong>{selectedLogicalTarget.name}</strong>. Artifact details and capabilities are available from the file tree.</div>}
      </section>

      <section className={styles.panel} aria-labelledby="observations-heading">
        <div className={styles.panelHeader}><h2 id="observations-heading">Knowledge observed</h2><span className={styles.muted}>{data.counts.observations} normalized record{data.counts.observations === 1 ? '' : 's'}</span></div>
        {data.observations.length ? data.observations.map((observation) => <div className={styles.listRow} key={observation.id}><span className={styles.observationMain}><strong>{observationTitle(observation)}</strong><small>{observation.type} · {observation.source} · {Object.keys(observation.attributes).length} attribute{Object.keys(observation.attributes).length === 1 ? '' : 's'}</small></span><span className={styles.type}>{observation.kind}</span></div>) : <p className={styles.muted}>Completed providers will publish typed entities and relationships here.</p>}
      </section>

      <div className={styles.bottomGrid}>
        <section className={styles.panel} aria-labelledby="workers-heading"><div className={styles.panelHeader}><h2 id="workers-heading">Analysis workers</h2><span className={styles.muted}>{data.workers.length} registered</span></div>{data.workers.length ? data.workers.map((worker) => <div className={styles.listRow} key={worker.workerId}><span className={styles.observationMain}><strong><Server size={13} aria-hidden="true" /> {worker.workerId}</strong><small>Last seen {new Date(worker.lastSeenAt).toLocaleString()} · {worker.lastSelected} selected · {worker.lastCompleted} completed</small>{worker.lastError && <small className={styles.uploadError}>{worker.lastError}</small>}</span><span className={styles.type}>{worker.status}</span></div>) : <p className={styles.muted}>No worker has reported a dispatch heartbeat yet.</p>}</section>
        <section className={styles.panel} aria-labelledby="work-heading"><div className={styles.panelHeader}><h2 id="work-heading">Tasks and findings</h2></div>{!data.tasks.length && !data.findings.length ? <p className={styles.muted}>No analysis work has been scheduled.</p> : <>{data.tasks.length > 0 && <WorkspaceTaskList projectId={projectId} tasks={data.tasks} onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: ['reamon-workspace', projectId] })
        }} />}{data.findings.map((finding) => <div className={styles.listRow} key={finding.id}><span>{finding.title}</span><span className={styles.type}>{finding.severity} · {finding.status}</span></div>)}</>}</section>
        <section className={styles.panel} aria-labelledby="hypotheses-heading"><div className={styles.panelHeader}><h2 id="hypotheses-heading">Hypotheses</h2></div>{data.hypotheses.length ? data.hypotheses.map((hypothesis) => <div className={styles.listRow} key={hypothesis.id}><span>{hypothesis.statement}</span><span className={styles.type}>{hypothesis.status}</span></div>) : <p className={styles.muted}>No hypotheses recorded.</p>}</section>
        <section className={styles.panel} aria-labelledby="projection-runs-heading"><div className={styles.panelHeader}><h2 id="projection-runs-heading">Graph replays</h2><span className={styles.muted}>{data.projectionRuns.length} recent</span></div>{data.projectionRuns.length ? data.projectionRuns.map((run) => <div className={styles.listRow} key={run.projectionRunId}><span className={styles.observationMain}><strong>{run.status} · {run.selected.toLocaleString()} observations</strong><small>{run.nodes.toLocaleString()} nodes · {run.relationships.toLocaleString()} relationships · page offset {run.offset.toLocaleString()}</small>{run.error && <small className={styles.uploadError}>{run.error}</small>}</span><span className={styles.type}>{new Date(run.startedAt).toLocaleString()}</span></div>) : <p className={styles.muted}>Graph replay history will appear after a provider publishes observations.</p>}</section>
        <section className={styles.panel} aria-labelledby="activity-heading"><div className={styles.panelHeader}><h2 id="activity-heading">Recent activity</h2></div>{data.activities.length ? data.activities.map((activity) => <div className={styles.activityRow} key={activity.id}><span className={styles.activityDot} /><div><strong>{activity.actor}</strong><p>{activity.message}</p><time>{new Date(activity.createdAt).toLocaleString()}</time></div></div>) : <p className={styles.muted}>Activity will appear as the workspace changes.</p>}</section>
      </div>
    </div>
  )
}

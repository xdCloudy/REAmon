'use client'

import { use, useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, CircleDashed, Gauge, Waypoints } from 'lucide-react'
import { WorkspaceFileTree } from '@/components/reamon/WorkspaceFileTree'
import { WorkspaceImportPanel } from '@/components/reamon/WorkspaceImportPanel'
import type { CapabilityMatch, ProgressMetric, TargetProfile, WorkspaceCapabilitySummary, WorkspaceImportSnapshot, WorkspaceProfile } from '@/lib/reamon'
import styles from './page.module.css'

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
  tasks: Array<{ id: string; title: string; category: string; status: string; progress: number }>
  findings: Array<{ id: string; title: string; severity: string; status: string }>
  hypotheses: Array<{ id: string; statement: string; status: string }>
  evidence: Array<{ id: string; summary: string; source: string; createdAt: string }>
  activities: Array<{ id: string; actor: string; eventType: string; message: string; createdAt: string }>
  capabilities: WorkspaceCapabilitySummary[]
  imports: WorkspaceImportSnapshot[]
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
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function profileLabel(profile: TargetProfile): string {
  const details = [profile.format.toUpperCase()]
  if (profile.architecture) details.push(profile.architecture)
  if (profile.platform) details.push(profile.platform)
  return details.join(' · ')
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
      {latestImport.missingPaths.length > 0 && <p className={styles.uploadError}>{latestImport.missingPaths.length} file paths still need upload. Retry the import to resume.</p>}
      {latestImport.errorSummary && <p className={styles.uploadError}>{latestImport.errorSummary}</p>}
    </div>
  )
}

export default function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = use(params)
  const queryClient = useQueryClient()
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null)
  const workspace = useQuery({ queryKey: ['reamon-workspace', projectId], queryFn: () => fetchWorkspace(projectId) })

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

      <div className={styles.stats}>
        <Stat label="Targets" value={data.counts.targets} /><Stat label="Artifacts" value={data.counts.artifacts} /><Stat label="Tasks" value={data.counts.tasks} /><Stat label="Findings" value={data.counts.findings} /><Stat label="Hypotheses" value={data.counts.hypotheses} /><Stat label="Evidence" value={data.counts.evidence} />
      </div>

      <WorkspaceImportPanel projectId={projectId} onImported={() => void queryClient.invalidateQueries({ queryKey: ['reamon-workspace', projectId] })} />
      <ImportStatus latestImport={latestImport} />

      <section className={styles.panel} aria-labelledby="inventory-heading">
        <div className={styles.panelHeader}><h2 id="inventory-heading">Workspace inventory</h2><span className={styles.muted}>{rootTarget ? profileLabel(rootTarget.profile) : 'Awaiting import'}</span></div>
        <WorkspaceProfileCard profile={rootTarget?.profile.format === 'directory' ? rootTarget.profile as WorkspaceProfile : null} />
      </section>

      <div className={styles.grid}>
        <section className={styles.panel} aria-labelledby="progress-heading"><div className={styles.panelHeader}><h2 id="progress-heading">Progress</h2><span className={styles.muted}>Deterministic lifecycle state</span></div>{data.progress.metrics.length ? data.progress.metrics.map((metric) => <ProgressBar key={metric.id} metric={metric} />) : <p className={styles.muted}>Progress appears as investigation entities are created.</p>}</section>
        <section className={styles.panel} aria-labelledby="providers-heading"><div className={styles.panelHeader}><h2 id="providers-heading">Available capabilities</h2><span className={styles.muted}>{data.capabilities.length} provider{data.capabilities.length === 1 ? '' : 's'}</span></div>{data.capabilities.length ? data.capabilities.map((provider) => <div className={styles.providerRow} key={provider.pluginId}><span><strong>{provider.pluginName}</strong><small>{provider.capabilities.slice(0, 4).join(' · ')}</small></span><span className={styles.providerCount}>{provider.compatibleArtifactIds.length} compatible artifacts</span></div>) : <p className={styles.muted}>Capabilities will appear as providers are registered.</p>}</section>
      </div>

      <section className={styles.panel} aria-labelledby="files-heading">
        <div className={styles.panelHeader}><h2 id="files-heading">Project files</h2><span className={styles.muted}>Relative paths are preserved as workspace context</span></div>
        <WorkspaceFileTree projectId={projectId} rootName={latestImport?.rootName || data.workspace.name} artifacts={data.artifacts} />
      </section>

      <section className={styles.panel} aria-labelledby="targets-heading">
        <div className={styles.panelHeader}><h2 id="targets-heading">Logical analysis targets</h2><span className={styles.muted}>{logicalTargets.length} detected</span></div>
        {logicalTargets.length ? <div className={styles.logicalTargets}>{logicalTargets.map((target) => <button type="button" key={target.id} className={`${styles.logicalTarget} ${selectedTarget === target.id ? styles.logicalTargetSelected : ''}`} onClick={() => setSelectedTarget(target.id)}><span><Waypoints size={16} /><strong>{target.name}</strong><small>{target.targetType} · {profileLabel(target.profile)}</small></span><span className={styles.status}><CheckCircle2 size={14} /> {target.status}</span></button>)}</div> : <div className={styles.empty}><CircleDashed size={25} /><span>Executable and library candidates will become logical targets after import.</span></div>}
        {selectedLogicalTarget && <div className={styles.targetNotice}>Selected target: <strong>{selectedLogicalTarget.name}</strong>. Artifact details and capabilities are available from the file tree.</div>}
      </section>

      <div className={styles.bottomGrid}>
        <section className={styles.panel} aria-labelledby="work-heading"><div className={styles.panelHeader}><h2 id="work-heading">Tasks and findings</h2></div>{!data.tasks.length && !data.findings.length ? <p className={styles.muted}>No analysis work has been scheduled.</p> : <>{data.tasks.map((task) => <div className={styles.listRow} key={task.id}><span>{task.title}</span><span className={styles.type}>{task.status} · {task.progress}%</span></div>)}{data.findings.map((finding) => <div className={styles.listRow} key={finding.id}><span>{finding.title}</span><span className={styles.type}>{finding.severity} · {finding.status}</span></div>)}</>}</section>
        <section className={styles.panel} aria-labelledby="hypotheses-heading"><div className={styles.panelHeader}><h2 id="hypotheses-heading">Hypotheses</h2></div>{data.hypotheses.length ? data.hypotheses.map((hypothesis) => <div className={styles.listRow} key={hypothesis.id}><span>{hypothesis.statement}</span><span className={styles.type}>{hypothesis.status}</span></div>) : <p className={styles.muted}>No hypotheses recorded.</p>}</section>
        <section className={styles.panel} aria-labelledby="activity-heading"><div className={styles.panelHeader}><h2 id="activity-heading">Recent activity</h2></div>{data.activities.length ? data.activities.map((activity) => <div className={styles.activityRow} key={activity.id}><span className={styles.activityDot} /><div><strong>{activity.actor}</strong><p>{activity.message}</p><time>{new Date(activity.createdAt).toLocaleString()}</time></div></div>) : <p className={styles.muted}>Activity will appear as the workspace changes.</p>}</section>
      </div>
    </div>
  )
}

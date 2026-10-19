'use client'

import { use, useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Server } from 'lucide-react'
import { WorkspaceFileTree } from '@/components/reamon/WorkspaceFileTree'
import { WorkspaceImportPanel } from '@/components/reamon/WorkspaceImportPanel'
import { WorkspaceAnalysisPlanPanel, type WorkspaceAnalysisPlan } from '@/components/reamon/WorkspaceAnalysisPlan'
import { WorkspaceDecompilationAction } from '@/components/reamon/WorkspaceDecompilationAction'
import { ToCodeImportAction } from '@/components/reamon/ToCodeImportAction'
import { WorkspaceTaskList } from '@/components/reamon/WorkspaceTaskList'
import { WorkspaceFindingList } from '@/components/reamon/WorkspaceFindingList'
import { WorkspaceCodeVisualizer } from '@/components/reamon/WorkspaceCodeVisualizer'
import { summarizeWorkerAttention } from '@/lib/reamon/worker-health'
import type { CapabilityMatch, TargetProfile, WorkspaceCapabilitySummary, WorkspaceImportSnapshot, WorkspaceObservation, WorkspaceProfile } from '@/lib/reamon'
import styles from './page.module.css'

type WorkerHealth = { workerId: string; status: string; lastSeenAt: string; lastDispatchAt: string | null; lastDispatchDurationMs: number | null; lastRecovered: number; lastSelected: number; lastCompleted: number; lastFailed: number; lastError: string }

interface WorkspaceSnapshot {
  workspace: { id: string; name: string; description: string | null; projectKind: string; createdAt: string; updatedAt: string }
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
  tasks: Array<{ id: string; title: string; category: string; status: string; progress: number; progressMessage: string; error: string; providerId: string | null; capability: string | null; result: Record<string, unknown> | null; startedAt: string | null; leaseOwner: string | null; leaseHeartbeatAt: string | null; approval: { id: string; status: string } | null }>
  findings: Array<{ id: string; title: string; severity: string; status: string }>
  hypotheses: Array<{ id: string; statement: string; status: string }>
  evidence: Array<{ id: string; summary: string; source: string; createdAt: string }>
  observations: WorkspaceObservation[]
  projectionRuns: Array<{ projectionRunId: string; status: string; offset: number; selected: number; nodes: number; relationships: number; truncated: boolean; reconciled: boolean; deletedNodes: number; deletedRelationships: number; error: string; startedAt: string; completedAt: string | null }>
  activities: Array<{ id: string; actor: string; eventType: string; message: string; createdAt: string }>
  capabilities: WorkspaceCapabilitySummary[]
  imports: WorkspaceImportSnapshot[]
  artifactPage: { limit: number; total: number; hasMore: boolean }
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

function countFrom(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  }
  return null
}

function hasIncompleteCodeUnitCoverage(result: Record<string, unknown> | null | undefined): boolean {
  if (!result) return false
  const inventory = result.coverageInventory && typeof result.coverageInventory === 'object' && !Array.isArray(result.coverageInventory)
    ? result.coverageInventory as Record<string, unknown>
    : null
  const discovered = countFrom(inventory, ['discoveredUnitCount'])
    ?? countFrom(result, ['decompiledCodeUnitCount', 'discoveredCodeUnitCount', 'decompiledClassCount', 'classCount', 'functionCount'])
  const indexed = countFrom(inventory, ['indexedUnitCount'])
    ?? countFrom(result, ['returnedCodeUnitCount', 'returnedClassCount', 'returnedFunctionCount'])
  const notObserved = countFrom(inventory, ['notObservedUnitCount'])
  const notIndexed = countFrom(inventory, ['notIndexedUnitCount'])
  const unreturned = countFrom(inventory, ['unreturnedDiscoveredUnitCount', 'unaccountedDiscoveredUnitCount'])
  if ([notObserved, notIndexed, unreturned].some((count) => count !== null && count > 0)) return true
  if (discovered !== null && indexed !== null) return indexed < discovered
  if (inventory && typeof inventory.truncated === 'boolean') return inventory.truncated
  return result.truncated === true
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

function ImportStatus({ latestImport, projectId, onChanged }: { latestImport: WorkspaceImportSnapshot | undefined; projectId: string; onChanged?: () => void }) {
  if (!latestImport) return null
  const percent = latestImport.totalBytes ? Math.round((latestImport.uploadedBytes / latestImport.totalBytes) * 100) : latestImport.totalFiles ? Math.round((latestImport.completedFiles / latestImport.totalFiles) * 100) : 0
  return (
    <div className={styles.importStatus} aria-live="polite">
      <div className={styles.panelHeader}><h2>Latest import</h2><span className={styles.type}>{latestImport.status}</span></div>
      <div className={styles.importStatusGrid}><span>Root</span><strong>{latestImport.rootName}</strong><span>Inventory</span><strong>{latestImport.totalFiles.toLocaleString()} files · {formatBytes(latestImport.totalBytes)}</strong><span>Transfer progress</span><strong>{latestImport.completedFiles.toLocaleString()} / {latestImport.totalFiles.toLocaleString()} files · {percent}%</strong><span>Profile</span><strong>{latestImport.profile?.interestingArtifacts ?? 0} interesting artifacts</strong></div>
      <p className={styles.muted}>Transfer progress only confirms that files reached the workspace. It does not measure decompilation or other analysis.</p>
      {latestImport.comparison && <p className={styles.muted}>{latestImport.comparison.mode === 'HASH' ? 'Authoritative refresh' : 'Manifest refresh'}: +{latestImport.comparison.addedCount} added · {latestImport.comparison.changedCount} changed · {latestImport.comparison.removedCount} removed · {latestImport.comparison.unchangedCount} unchanged.</p>}
      {latestImport.missingPaths.length > 0 && <p className={styles.uploadError}>{latestImport.missingPaths.length} file paths still need upload. Retry the import to resume.</p>}
      {latestImport.errorSummary && <p className={styles.uploadError}>{latestImport.errorSummary}</p>}
      {latestImport.status === 'COMPLETED' && latestImport.hasToCodeExport && <div className={styles.profileWide}>
        <div><strong>ToCode export found</strong><p className={styles.muted}>Index recovered functions and call relationships into the project database and code visualizer.</p></div>
        <ToCodeImportAction projectId={projectId} importId={latestImport.id} indexed={latestImport.toCodeIndexed} onChanged={onChanged} />
      </div>}
    </div>
  )
}

function WorkerHealthAlert({ workers }: { workers: WorkerHealth[] }) {
  const attention = summarizeWorkerAttention(workers)
  if (!attention) return null

  const names = attention.workers.slice(0, 3).map((worker) => worker.workerId).join(', ')
  const remainder = attention.workers.length > 3 ? ` and ${attention.workers.length - 3} more` : ''
  const message = attention.kind === 'degraded'
    ? `${attention.workers.length} responsive worker${attention.workers.length === 1 ? '' : 's'} reported a failed dispatch. Affected: ${names}${remainder}.`
    : attention.kind === 'stale'
      ? `No worker has checked in recently. ${attention.workers.length} registered worker${attention.workers.length === 1 ? ' is' : 's are'} stale: ${names}${remainder}.`
      : 'No worker has reported a heartbeat yet.'
  const guidance = attention.kind === 'degraded'
    ? 'Review the worker status details below before retrying failed tasks.'
    : 'New analysis tasks may wait until a worker checks in.'
  return (
    <aside className={styles.workerAlert} role="alert" aria-labelledby="worker-alert-heading">
      <AlertTriangle size={19} aria-hidden="true" />
      <div>
        <strong id="worker-alert-heading">Analysis worker attention required</strong>
        <p>{message}</p>
        <small>{guidance}</small>
      </div>
    </aside>
  )
}

export default function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = use(params)
  const queryClient = useQueryClient()
  const [decompilationActionPending, setDecompilationActionPending] = useState(false)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const workspace = useQuery({
    queryKey: ['reamon-workspace', projectId],
    queryFn: () => fetchWorkspace(projectId),
    refetchInterval: (query) => {
      const snapshot = query.state.data
      if (decompilationActionPending || snapshot?.tasks.some((task) => task.status === 'RUNNING')) return 3000
      if (snapshot?.workers.length) return 30000
      return false
    },
    refetchIntervalInBackground: false,
  })
  const analysisPlan = useQuery({
    queryKey: ['reamon-analysis-plan', projectId],
    queryFn: () => fetchAnalysisPlan(projectId),
    refetchInterval: (query) => query.state.data?.steps.some((step) => ['AWAITING_APPROVAL', 'QUEUED', 'RUNNING'].includes(step.latestTask?.status || '')) ? 3000 : false,
    refetchIntervalInBackground: false,
  })

  const data = workspace.data
  const rootTarget = useMemo(() => data?.targets.find((target) => target.targetType === 'DIRECTORY'), [data?.targets])
  const latestImport = data?.imports[0]
  const hasDecompilableArtifact = data?.artifacts.some((artifact) => ['apk', 'jar', 'dex', 'class', 'elf', 'pe', 'pe-dll', 'pe-dotnet', 'macho'].includes(artifact.profile.format)) ?? false
  const decompileTask = data?.tasks.find((task) => task.capability === 'decompile')
  const decompileResult = decompileTask?.result
  const returnedClassCount = typeof decompileResult?.returnedClassCount === 'number' ? decompileResult.returnedClassCount : null
  const discoveredClassCount = typeof decompileResult?.decompiledClassCount === 'number' ? decompileResult.decompiledClassCount : null
  const sourceScanLimited = typeof decompileResult?.warnings === 'string' && /produced more than|source scan.*limit/i.test(decompileResult.warnings)
  const hasPartialDecompilation = decompileTask?.status === 'COMPLETED' && hasIncompleteCodeUnitCoverage(decompileResult)
  const decompileProposal = analysisPlan.data?.steps.find((step) => step.capability === 'decompile')
  const decompilationTaskActive = decompileTask && ['AWAITING_APPROVAL', 'QUEUED', 'RUNNING'].includes(decompileTask.status)

  if (workspace.isLoading) return <div className={styles.loading}>Loading workspace…</div>
  if (workspace.isError || !data) return <div className={styles.error}>Unable to load this workspace. Check that it still exists.</div>

  return (
    <div className={styles.page}>
      <div className={styles.topbar}>
        <Link href="/projects" className={styles.backLink}><ArrowLeft size={15} /> Projects</Link>
      </div>

      <header className={styles.hero}>
        <div><p className={styles.eyebrow}>Reverse-engineering workspace</p><h1>{data.workspace.name}</h1><p className={styles.description}>{data.workspace.description || 'Analyse anything. Connect the evidence. Understand the system.'}</p></div>
      </header>

      <WorkerHealthAlert workers={data.workers} />

      <WorkspaceImportPanel projectId={projectId} onImported={() => {
        void queryClient.invalidateQueries({ queryKey: ['reamon-workspace', projectId] })
        void queryClient.invalidateQueries({ queryKey: ['reamon-analysis-plan', projectId] })
        void queryClient.invalidateQueries({ queryKey: ['reamon-code-units', projectId] })
      }} />
      <ImportStatus latestImport={latestImport} projectId={projectId} onChanged={() => {
        void queryClient.invalidateQueries({ queryKey: ['reamon-workspace', projectId] })
        void queryClient.invalidateQueries({ queryKey: ['reamon-code-units', projectId] })
      }} />
      {hasDecompilableArtifact && <aside className={styles.analysisNextStep} id="analysis-next-step">
        <div><strong>{hasPartialDecompilation && returnedClassCount !== null ? discoveredClassCount !== null && !sourceScanLimited ? `Previous run indexed ${returnedClassCount.toLocaleString()} of ${discoveredClassCount.toLocaleString()} Java classes.` : `At least ${returnedClassCount.toLocaleString()} Java classes indexed; the total is unknown.` : decompileTask?.status === 'AWAITING_APPROVAL' ? 'Decompilation is waiting for approval.' : decompileTask?.status === 'QUEUED' ? 'Decompilation is queued.' : decompileTask?.status === 'RUNNING' ? 'Decompilation is running.' : decompileTask?.status === 'COMPLETED' ? 'Decompilation run finished.' : decompileTask?.status === 'FAILED' ? 'Decompilation failed.' : decompileTask?.status === 'CANCELLED' ? 'Decompilation was cancelled.' : 'Import complete; decompilation has not started.'}</strong><p>{hasPartialDecompilation ? 'This run did not index every code unit. A new run uses the current analyzer limits, so very large targets can still be partial. This performs static decompilation; it does not launch the Android app.' : decompileTask?.status === 'AWAITING_APPROVAL' ? 'Approve this task under Tasks and findings, then choose Run.' : decompileTask?.status === 'QUEUED' ? 'The approved task is ready. Choose Run under Tasks and findings.' : decompileTask?.status === 'RUNNING' ? decompileTask.progressMessage || 'The isolated analyzer is processing the imported artifact.' : decompileTask?.status === 'COMPLETED' ? 'Review indexed coverage and any supplemental evidence limits in the visualizer below. Start another run to refresh the results.' : decompileTask ? 'Review the task details below, or start a fresh analysis attempt.' : 'Choose Run decompilation to start the matching isolated analyzer for this imported artifact. This performs static analysis; it does not launch the Android app.'}</p></div>
        {!decompilationTaskActive && decompileProposal && <WorkspaceDecompilationAction projectId={projectId} artifactId={decompileProposal.artifactId} providerId={decompileProposal.provider.pluginId} hasPreviousRun={Boolean(decompileTask)} onPendingChange={setDecompilationActionPending} onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: ['reamon-workspace', projectId] })
          void queryClient.invalidateQueries({ queryKey: ['reamon-code-units', projectId] })
        }} />}
        {!decompilationTaskActive && analysisPlan.isLoading && <span className={styles.muted}>Finding a compatible decompiler…</span>}
        {!decompilationTaskActive && analysisPlan.isError && <span className={styles.uploadError}>Available analysis proposals could not be loaded. Refresh the workspace and try again.</span>}
        {!decompilationTaskActive && !analysisPlan.isLoading && !analysisPlan.isError && !decompileProposal && <span className={styles.muted}>No compatible decompiler is available for this artifact.</span>}
        {decompileTask && <a href="#analysis-tasks">Open task controls</a>}
        <a href="#analysis-proposals">View all analysis proposals</a>
      </aside>}
      <WorkspaceAnalysisPlanPanel projectId={projectId} plan={analysisPlan.data} isLoading={analysisPlan.isLoading} isError={analysisPlan.isError} onScheduled={() => {
        void queryClient.invalidateQueries({ queryKey: ['reamon-workspace', projectId] })
        void queryClient.invalidateQueries({ queryKey: ['reamon-code-units', projectId] })
        void queryClient.invalidateQueries({ queryKey: ['reamon-analysis-plan', projectId] })
      }} onScanned={() => {
        void queryClient.invalidateQueries({ queryKey: ['reamon-workspace', projectId] })
        void queryClient.invalidateQueries({ queryKey: ['reamon-analysis-plan', projectId] })
      }} />
      <WorkspaceCodeVisualizer
        projectId={projectId}
        isAnalyzing={data.tasks.some((task) => task.status === 'RUNNING')}
        decompilationTask={decompileTask ? { status: decompileTask.status, progressMessage: decompileTask.progressMessage } : undefined}
        decompilationHref={hasDecompilableArtifact ? '#analysis-next-step' : undefined}
      />

      <section className={styles.panel} aria-labelledby="files-heading">
        <div className={styles.panelHeader}><h2 id="files-heading">Project files</h2><span className={styles.muted}>Relative paths are preserved as workspace context</span></div>
        <WorkspaceFileTree projectId={projectId} rootName={latestImport?.rootName || data.workspace.name} artifacts={data.artifacts} totalArtifacts={data.artifactPage.total} hasMoreArtifacts={data.artifactPage.hasMore} />
      </section>

      <section id="analysis-tasks" className={styles.panel} aria-labelledby="work-heading"><div className={styles.panelHeader}><h2 id="work-heading">Tasks and findings</h2></div>{!data.tasks.length && !data.findings.length ? <p className={styles.muted}>No analysis work has been scheduled.</p> : <>{data.tasks.length > 0 && <WorkspaceTaskList projectId={projectId} tasks={data.tasks} onChanged={() => {
        void queryClient.invalidateQueries({ queryKey: ['reamon-workspace', projectId] })
        void queryClient.invalidateQueries({ queryKey: ['reamon-code-units', projectId] })
      }} />}{data.findings.length > 0 && <WorkspaceFindingList projectId={projectId} findings={data.findings} onChanged={() => {
        void queryClient.invalidateQueries({ queryKey: ['reamon-workspace', projectId] })
      }} />}</>}</section>

      <details className={styles.secondaryDetails} onToggle={(event) => setShowDiagnostics(event.currentTarget.open)}>
        <summary>Project data and diagnostics <span>{data.counts.targets} targets · {data.counts.observations} knowledge records · {data.counts.hypotheses} hypotheses</span></summary>
        {showDiagnostics && <div className={styles.secondaryGrid}>
          <section className={styles.panel} aria-labelledby="inventory-heading">
            <div className={styles.panelHeader}><h2 id="inventory-heading">Workspace profile</h2><span className={styles.muted}>{rootTarget ? profileLabel(rootTarget.profile) : 'Awaiting import'}</span></div>
            <WorkspaceProfileCard profile={rootTarget?.profile.format === 'directory' ? rootTarget.profile as WorkspaceProfile : null} />
          </section>
          <section className={styles.panel} aria-labelledby="providers-heading"><div className={styles.panelHeader}><h2 id="providers-heading">Available analysis methods</h2><span className={styles.muted}>{data.capabilities.length} provider{data.capabilities.length === 1 ? '' : 's'}</span></div>{data.capabilities.length ? data.capabilities.map((provider) => <div className={styles.providerRow} key={provider.pluginId}><span><strong>{provider.pluginName}</strong><small>{provider.capabilities.slice(0, 4).join(' · ')}</small><small>Accepts {provider.acceptsFormats.slice(0, 3).join(', ')} · produces {provider.produces.slice(0, 3).join(', ') || 'analysis results'}</small></span><span className={styles.providerCount}>{provider.compatibleArtifactIds.length} compatible files</span></div>) : <p className={styles.muted}>Analysis methods appear as providers are registered.</p>}</section>
          <section className={styles.panel} aria-labelledby="observations-heading">
            <div className={styles.panelHeader}><h2 id="observations-heading">Project knowledge</h2><span className={styles.muted}>{data.counts.observations} records</span></div>
            {data.observations.length ? data.observations.map((observation) => <div className={styles.listRow} key={observation.id}><span className={styles.observationMain}><strong>{observationTitle(observation)}</strong><small>{observation.type} · {observation.source} · {Object.keys(observation.attributes).length} attributes</small></span><span className={styles.type}>{observation.kind}</span></div>) : <p className={styles.muted}>Completed analyses will add entities and relationships here.</p>}
          </section>
        <section className={styles.panel} aria-labelledby="workers-heading"><div className={styles.panelHeader}><h2 id="workers-heading">Analysis workers</h2><span className={styles.muted}>{data.workers.length} registered</span></div>{data.workers.length ? data.workers.map((worker) => <div className={styles.listRow} key={worker.workerId}><span className={styles.observationMain}><strong><Server size={13} aria-hidden="true" /> {worker.workerId}</strong><small>Last seen {new Date(worker.lastSeenAt).toLocaleString()} · {worker.lastSelected} selected · {worker.lastCompleted} completed</small>{worker.lastError && <small className={styles.uploadError}>{worker.lastError}</small>}</span><span className={styles.type}>{worker.status}</span></div>) : <p className={styles.muted}>No worker has reported a dispatch heartbeat yet.</p>}</section>
        <section className={styles.panel} aria-labelledby="hypotheses-heading"><div className={styles.panelHeader}><h2 id="hypotheses-heading">Hypotheses</h2></div>{data.hypotheses.length ? data.hypotheses.map((hypothesis) => <div className={styles.listRow} key={hypothesis.id}><span>{hypothesis.statement}</span><span className={styles.type}>{hypothesis.status}</span></div>) : <p className={styles.muted}>No hypotheses recorded.</p>}</section>
        <section className={styles.panel} aria-labelledby="projection-runs-heading"><div className={styles.panelHeader}><h2 id="projection-runs-heading">Graph replays</h2><span className={styles.muted}>{data.projectionRuns.length} recent</span></div>{data.projectionRuns.length ? data.projectionRuns.map((run) => <div className={styles.listRow} key={run.projectionRunId}><span className={styles.observationMain}><strong>{run.status} · {run.selected.toLocaleString()} observations</strong><small>{run.nodes.toLocaleString()} nodes · {run.relationships.toLocaleString()} relationships · page offset {run.offset.toLocaleString()}</small>{run.reconciled && <small>Reconciled · removed {run.deletedNodes.toLocaleString()} nodes / {run.deletedRelationships.toLocaleString()} relationships</small>}{run.error && <small className={styles.uploadError}>{run.error}</small>}</span><span className={styles.type}>{new Date(run.startedAt).toLocaleString()}</span></div>) : <p className={styles.muted}>Graph replay history will appear after a provider publishes observations.</p>}</section>
        <section className={styles.panel} aria-labelledby="activity-heading"><div className={styles.panelHeader}><h2 id="activity-heading">Recent activity</h2></div>{data.activities.length ? data.activities.map((activity) => <div className={styles.activityRow} key={activity.id}><span className={styles.activityDot} /><div><strong>{activity.actor}</strong><p>{activity.message}</p><time>{new Date(activity.createdAt).toLocaleString()}</time></div></div>) : <p className={styles.muted}>Activity will appear as the workspace changes.</p>}</section>
        </div>}
      </details>
    </div>
  )
}

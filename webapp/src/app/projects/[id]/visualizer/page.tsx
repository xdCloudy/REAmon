'use client'

import { use } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { WorkspaceCodeVisualizer } from '@/components/reamon/WorkspaceCodeVisualizer'
import styles from './page.module.css'

interface VisualizerWorkspaceContext {
  workspace: { id: string; name: string }
  tasks: Array<{ capability: string | null; status: string; progressMessage: string }>
}

async function fetchWorkspaceContext(projectId: string): Promise<VisualizerWorkspaceContext> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/workspace`, { cache: 'no-store' })
  if (!response.ok) throw new Error('Unable to load the project workspace')
  return response.json()
}

export default function ProjectVisualizerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = use(params)
  const workspace = useQuery({
    queryKey: ['reamon-visualizer-workspace', projectId],
    queryFn: () => fetchWorkspaceContext(projectId),
    refetchInterval: (query) => query.state.data?.tasks.some((task) => task.status === 'RUNNING') ? 3000 : false,
    refetchIntervalInBackground: false,
  })
  const tasks = workspace.data?.tasks || []
  const decompilationTask = tasks.find((task) => task.capability === 'decompile')

  return <main className={styles.page}>
    <Link className={styles.backLink} href={`/projects/${encodeURIComponent(projectId)}`}>
      <ArrowLeft size={16} aria-hidden="true" />
      {workspace.data?.workspace.name || 'Project workspace'}
    </Link>
    {workspace.isError && <p className={styles.error} role="alert">{workspace.error instanceof Error ? workspace.error.message : 'Unable to load project status'}</p>}
    <WorkspaceCodeVisualizer
      projectId={projectId}
      isAnalyzing={tasks.some((task) => task.status === 'RUNNING')}
      decompilationTask={decompilationTask ? { status: decompilationTask.status, progressMessage: decompilationTask.progressMessage } : undefined}
      decompilationHref={`/projects/${encodeURIComponent(projectId)}#analysis-next-step`}
      standalone
    />
  </main>
}

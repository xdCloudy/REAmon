'use client'

import { useEffect, useRef, useState } from 'react'

interface ProjectBuildReceipt {
  sourceSha256: string
  dependencySha256: string
  validationStatus: 'PASSED' | 'FAILED'
  validationMethod: string
  validationMessage: string
  compiledSha256: string | null
  packageCount: number
  files: Array<{ relativePath: string; sourceSha256: string; acceptedReviewId: string }>
  dependencies: Array<{ relativePath: string; sourceSha256: string }>
}

export function ProjectGoBuild({ projectId, taskId, className }: {
  projectId: string
  taskId: string
  className?: string
}) {
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<ProjectBuildReceipt | null>(null)
  const buildStarted = useRef(false)

  useEffect(() => {
    let ignore = false
    buildStarted.current = false
    setReceipt(null)
    setError(null)
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/go-project-build?taskId=${encodeURIComponent(taskId)}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { error?: unknown; receipt?: ProjectBuildReceipt | null } | null
        if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : 'The saved Go project build receipt could not be loaded.')
        if (!ignore && !buildStarted.current) setReceipt(payload?.receipt ?? null)
      })
      .catch((loadError) => {
        if (!ignore && !buildStarted.current) setError(loadError instanceof Error ? loadError.message : 'The saved Go project build receipt could not be loaded.')
      })
    return () => { ignore = true }
  }, [projectId, taskId])

  async function buildProject() {
    buildStarted.current = true
    setBuilding(true)
    setError(null)
    setReceipt(null)
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/go-project-build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      })
      const payload = await response.json().catch(() => null) as { error?: unknown; receipt?: ProjectBuildReceipt } | null
      if (!response.ok || !payload?.receipt) throw new Error(typeof payload?.error === 'string' ? payload.error : 'The Go project build did not complete.')
      setReceipt(payload.receipt)
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : 'The Go project build did not complete.')
    } finally {
      setBuilding(false)
    }
  }

  return <span className="reamon-project-csharp-build">
    <button type="button" className={className} onClick={() => void buildProject()} disabled={building} aria-busy={building}>
      {building ? 'Building accepted Go…' : 'Build accepted Go files'}
    </button>
    {error && <span role="alert">{error}</span>}
    {receipt && <span role="status">
      {receipt.validationStatus === 'PASSED' ? 'Go project build passed' : 'Go project build failed'} · {receipt.files.length} {receipt.files.length === 1 ? 'file' : 'files'} · {receipt.packageCount} {receipt.packageCount === 1 ? 'package' : 'packages'} · receipt {receipt.sourceSha256.slice(0, 12)}
      {receipt.validationMessage ? ` — ${receipt.validationMessage}` : ''}
      {receipt.dependencies.length > 0 ? ` · ${receipt.dependencies.length} dependency ${receipt.dependencies.length === 1 ? 'manifest' : 'manifests'} verified` : ''}
    </span>}
  </span>
}

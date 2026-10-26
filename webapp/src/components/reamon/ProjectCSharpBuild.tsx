'use client'

import { useState } from 'react'

interface ProjectBuildReceipt {
  sourceSha256: string
  validationStatus: 'PASSED' | 'FAILED'
  validationMethod: string
  validationMessage: string
  compiledSha256: string | null
  files: Array<{ relativePath: string; sourceSha256: string; acceptedReviewId: string }>
}

export function ProjectCSharpBuild({ projectId, taskId, className }: {
  projectId: string
  taskId: string
  className?: string
}) {
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<ProjectBuildReceipt | null>(null)

  async function buildProject() {
    setBuilding(true)
    setError(null)
    setReceipt(null)
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/visualizer/maintained/project-build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      })
      const payload = await response.json().catch(() => null) as { error?: unknown; receipt?: ProjectBuildReceipt } | null
      if (!response.ok || !payload?.receipt) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'The C# project build did not complete.')
      }
      setReceipt(payload.receipt)
    } catch (buildError) {
      setError(buildError instanceof Error ? buildError.message : 'The C# project build did not complete.')
    } finally {
      setBuilding(false)
    }
  }

  return <span className="reamon-project-csharp-build">
    <button type="button" className={className} onClick={() => void buildProject()} disabled={building} aria-busy={building}>
      {building ? 'Building accepted C#…' : 'Build accepted C# files'}
    </button>
    {error && <span role="alert">{error}</span>}
    {receipt && <span role="status">
      {receipt.validationStatus === 'PASSED' ? 'Project build passed' : 'Project build failed'} · {receipt.files.length} {receipt.files.length === 1 ? 'file' : 'files'} · receipt {receipt.sourceSha256.slice(0, 12)}
      {receipt.validationMessage ? ` — ${receipt.validationMessage}` : ''}
    </span>}
  </span>
}

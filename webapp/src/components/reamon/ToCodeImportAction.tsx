'use client'

import { useState } from 'react'
import styles from './WorkspaceDecompilationAction.module.css'

interface IndexResult {
  error?: string
  indexedFunctions?: number
  callEdges?: number
  functionsWithReferencedStrings?: number
  functionsWithImportedCalls?: number
  alreadyIndexed?: boolean
}

export function ToCodeImportAction({ projectId, importId, indexed, onChanged }: {
  projectId: string
  importId: string
  indexed: boolean
  onChanged?: () => void
}) {
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  async function indexExport() {
    if (pending || indexed) return
    setPending(true)
    setFeedback(null)
    try {
      const response = await fetch(`/api/projects/${projectId}/imports/${importId}/tocode`, { method: 'POST' })
      const result = await response.json().catch(() => ({})) as IndexResult
      if (!response.ok) throw new Error(result.error || 'Unable to index ToCode export')
      setFeedback(`Indexed ${(result.indexedFunctions || 0).toLocaleString()} functions, ${(result.callEdges || 0).toLocaleString()} call relationships, ${(result.functionsWithReferencedStrings || 0).toLocaleString()} functions with referenced strings, and ${(result.functionsWithImportedCalls || 0).toLocaleString()} functions with imported calls${result.alreadyIndexed ? ' (already indexed)' : ''}.`)
      onChanged?.()
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Unable to index ToCode export')
    } finally {
      setPending(false)
    }
  }

  return <div className={styles.container}>
    <button type="button" className={styles.action} disabled={pending || indexed} onClick={() => void indexExport()}>
      {pending ? 'Indexing ToCode export…' : indexed ? 'ToCode export indexed' : 'Index ToCode export'}
    </button>
    {feedback && <p className={styles.feedback} role="status">{feedback}</p>}
  </div>
}

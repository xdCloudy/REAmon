'use client'

import { useState } from 'react'
import styles from './WorkspaceDecompilationAction.module.css'

interface IndexResult {
  error?: string
  indexedFunctions?: number
  callEdges?: number
  functionsWithReferencedStrings?: number
  functionsWithImportedCalls?: number
  functionsWithFieldReferences?: number
  recoveredTypeCount?: number
  truncatedTypeCatalogs?: number
  skippedTypeCatalogs?: number
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
      setFeedback(`Indexed ${(result.indexedFunctions || 0).toLocaleString()} functions, ${(result.callEdges || 0).toLocaleString()} call relationships, ${(result.functionsWithReferencedStrings || 0).toLocaleString()} functions with referenced strings, ${(result.functionsWithImportedCalls || 0).toLocaleString()} functions with imported calls, ${(result.functionsWithFieldReferences || 0).toLocaleString()} functions with field references, and ${(result.recoveredTypeCount || 0).toLocaleString()} recovered type declarations${result.truncatedTypeCatalogs ? ` (${result.truncatedTypeCatalogs} catalog${result.truncatedTypeCatalogs === 1 ? '' : 's'} truncated)` : ''}${result.skippedTypeCatalogs ? ` (${result.skippedTypeCatalogs} type catalog${result.skippedTypeCatalogs === 1 ? '' : 's'} skipped)` : ''}${result.alreadyIndexed ? ' (already indexed)' : ''}.`)
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

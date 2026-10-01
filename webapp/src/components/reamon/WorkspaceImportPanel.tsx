'use client'

import { useEffect, useRef, useState } from 'react'
import { FolderOpen, RefreshCw, Upload } from 'lucide-react'
import {
  formatBytes,
  runWorkspaceImport,
  selectionFromFiles,
  type ImportProgress,
  type WorkspaceSelection,
} from '@/lib/reamon/browser-import'
import styles from './WorkspaceImportPanel.module.css'

interface WorkspaceImportPanelProps {
  projectId: string
  onImported: () => void
}

function extensionOf(path: string): string {
  const name = path.split('/').pop() || path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

function Preview({ selection }: { selection: WorkspaceSelection }) {
  const executableExtensions = new Set(['.exe', '.dll', '.so', '.dylib', '.sys', '.elf', '.bin', '.apk', '.jar'])
  const sourceExtensions = new Set(['.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.java', '.kt', '.go', '.rs', '.py', '.js', '.ts'])
  const configExtensions = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.xml', '.config', '.conf'])
  const counts = selection.files.reduce((result, entry) => {
    const extension = extensionOf(entry.relativePath)
    if (executableExtensions.has(extension)) result.executables += 1
    if (sourceExtensions.has(extension)) result.source += 1
    if (configExtensions.has(extension)) result.config += 1
    return result
  }, { executables: 0, source: 0, config: 0 })

  return (
    <div className={styles.preview} aria-label="Workspace inventory preview">
      <div><strong>{selection.rootName}</strong><span>{selection.files.length.toLocaleString()} files · {formatBytes(selection.totalBytes)}</span></div>
      <div className={styles.previewStats}>
        <span>{counts.executables} binary candidates</span>
        <span>{counts.source} source files</span>
        <span>{counts.config} configuration files</span>
      </div>
    </div>
  )
}

function progressPercent(progress: ImportProgress): number {
  if (!progress.totalBytes) return progress.totalFiles ? Math.round((progress.completedFiles / progress.totalFiles) * 100) : 0
  return Math.min(100, Math.round((progress.uploadedBytes / progress.totalBytes) * 100))
}

export function WorkspaceImportPanel({ projectId, onImported }: WorkspaceImportPanelProps) {
  const directoryInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [selection, setSelection] = useState<WorkspaceSelection | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [importId, setImportId] = useState<string | undefined>()
  const [completedPaths, setCompletedPaths] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // `webkitdirectory` is still the broadly supported browser fallback for
    // selecting a directory. It is intentionally set as an attribute so the
    // TypeScript DOM types do not make Chromium's prefixed API a dependency.
    directoryInput.current?.setAttribute('webkitdirectory', '')
  }, [])

  const choose = (input: FileList | null) => {
    if (!input?.length) return
    try {
      setSelection(selectionFromFiles(input))
      setProgress(null)
      setImportId(undefined)
      setCompletedPaths(new Set())
      setError(null)
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : 'Unable to read the selected files')
    }
  }

  const start = async () => {
    if (!selection) return
    setBusy(true)
    setError(null)
    try {
      const result = await runWorkspaceImport({
        projectId,
        selection,
        importId,
        completedPaths,
        concurrency: 3,
        onProgress: (next) => {
          setProgress(next)
          if (next.phase === 'UPLOADING' && next.currentPath) {
            setCompletedPaths((current) => new Set(current))
          }
        },
      })
      setImportId(result.importId)
      if (result.failedPaths.length) {
        setError(`${result.failedPaths.length} file${result.failedPaths.length === 1 ? '' : 's'} failed. Retry to resume this import.`)
      } else {
        onImported()
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Workspace import failed')
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    setSelection(null)
    setProgress(null)
    setImportId(undefined)
    setCompletedPaths(new Set())
    setError(null)
    if (directoryInput.current) directoryInput.current.value = ''
    if (fileInput.current) fileInput.current.value = ''
  }

  return (
    <section className={styles.panel} aria-labelledby="workspace-import-heading">
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Start an investigation</p>
          <h2 id="workspace-import-heading">Import a workspace folder</h2>
          <p className={styles.muted}>The selected folder is uploaded as a snapshot. REAmon keeps every relative path and profiles the contents after upload.</p>
        </div>
        <FolderOpen size={26} aria-hidden="true" />
      </div>
      <div className={styles.actions}>
        <label className="primaryButton">
          <FolderOpen size={16} /> Choose project folder
          <input ref={directoryInput} type="file" multiple onChange={(event) => choose(event.target.files)} className={styles.hiddenInput} />
        </label>
        <label className="secondaryButton">
          <Upload size={16} /> Add files
          <input ref={fileInput} type="file" multiple onChange={(event) => choose(event.target.files)} className={styles.hiddenInput} />
        </label>
        {selection && <button type="button" className="secondaryButton" onClick={reset} disabled={busy}>Clear</button>}
      </div>
      {selection && <Preview selection={selection} />}
      {selection && progress && (
        <div className={styles.progress} aria-live="polite">
          <div className={styles.progressHeader}><span>{progress.phase === 'COMPLETED' ? 'Import complete' : progress.phase === 'FAILED' ? 'Import paused' : progress.phase === 'FINALIZING' ? 'Finalizing workspace' : 'Uploading workspace'}</span><strong>{progressPercent(progress)}%</strong></div>
          <div className={styles.track}><div className={styles.fill} style={{ width: `${progressPercent(progress)}%` }} /></div>
          <div className={styles.progressMeta}><span>{progress.completedFiles.toLocaleString()} / {progress.totalFiles.toLocaleString()} files</span><span>{formatBytes(progress.uploadedBytes)} / {formatBytes(progress.totalBytes)}</span></div>
          {progress.currentPath && <code>{progress.currentPath}</code>}
          {progress.failedPaths.length > 0 && <span className={styles.failure}>{progress.failedPaths.length} failed</span>}
        </div>
      )}
      {selection && (
        <button type="button" className="primaryButton" onClick={start} disabled={busy}>
          {busy ? <><RefreshCw size={16} className={styles.spin} /> Importing…</> : importId ? 'Retry failed files' : 'Import workspace'}
        </button>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <p className={styles.limits}>Everything selected is included by default. Upload limits are configurable by the server; the browser never exposes your absolute local path.</p>
    </section>
  )
}

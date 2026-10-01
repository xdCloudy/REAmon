'use client'

import { useEffect, useRef, useState } from 'react'
import { FolderOpen, RefreshCw, Upload } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCreateProject } from '@/hooks/useProjects'
import { useProject } from '@/providers/ProjectProvider'
import { useAlertModal, useToast } from '@/components/ui'
import { formatBytes, runWorkspaceImport, selectionFromFiles, type ImportProgress, type WorkspaceSelection } from '@/lib/reamon/browser-import'
import styles from './page.module.css'

export default function NewProjectPage() {
  const router = useRouter()
  const { userId, setCurrentProject } = useProject()
  const createProjectMutation = useCreateProject()
  const { alertError, alertWarning } = useAlertModal()
  const toast = useToast()
  const directoryInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selection, setSelection] = useState<WorkspaceSelection | null>(null)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    directoryInput.current?.setAttribute('webkitdirectory', '')
  }, [])

  const choose = (input: FileList | null) => {
    if (!input?.length) return
    try {
      const next = selectionFromFiles(input)
      setSelection(next)
      setProgress(null)
      setSelectionError(null)
      setImportError(null)
      setName((current) => current.trim() ? current : next.rootName)
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : 'Unable to read the selected source')
    }
  }

  const createWorkspace = async () => {
    if (!userId) {
      await alertWarning('Please select a user first')
      router.push('/projects')
      return
    }
    if (!name.trim()) {
      setSelectionError('Enter a workspace name or choose a folder first')
      return
    }

    setImportError(null)
    const project = await createProjectMutation.mutateAsync({
      userId,
      name: name.trim(),
      description: description.trim() || undefined,
      projectKind: 'REVERSE_ENGINEERING',
      targetDomain: '',
    })

    setCurrentProject({
      id: project.id,
      name: project.name,
      targetDomain: project.targetDomain || '',
      description: project.description || undefined,
      createdAt: project.createdAt.toString(),
      updatedAt: project.updatedAt.toString(),
    })

    if (selection) {
      try {
        const result = await runWorkspaceImport({
          projectId: project.id,
          selection,
          concurrency: 3,
          onProgress: setProgress,
        })
        if (result.failedPaths.length) {
          setImportError(`${result.failedPaths.length} files failed to upload. The workspace is available and the import can be retried from its dashboard.`)
          toast.warning('Workspace created with a partial import')
          router.push(`/projects/${project.id}`)
          return
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Workspace import failed'
        setImportError(message)
        toast.warning('Workspace created, but the folder import needs attention')
        router.push(`/projects/${project.id}`)
        return
      }
    }

    toast.success(selection ? 'Workspace created and imported' : 'Workspace created')
    router.push(`/projects/${project.id}`)
  }

  if (!userId) {
    return <div className={styles.container}><div className={styles.message}><p>Please select a user first before creating a workspace.</p><button className="primaryButton" onClick={() => router.push('/projects')}>Go to Projects</button></div></div>
  }

  const isSubmitting = createProjectMutation.isPending || Boolean(progress && progress.phase !== 'COMPLETED')
  const progressPercent = progress ? (progress.totalBytes ? Math.round((progress.uploadedBytes / progress.totalBytes) * 100) : 0) : 0

  return (
    <div className={styles.container}>
      <main className={styles.workspaceForm}>
        <div className={styles.formIntro}><p className={styles.kicker}>New investigation</p><h1>Create a reverse-engineering workspace</h1><p>Start with an application, system, repository, capture, or any other source. The selected folder becomes a snapshot root; files inside it remain related artifacts.</p></div>
        <section className={styles.formPanel} aria-labelledby="workspace-details-heading">
          <h2 id="workspace-details-heading">Workspace details</h2>
          <label className={styles.field}><span>Name</span><input className="textInput" value={name} onChange={(event) => setName(event.target.value)} placeholder="ExampleApp" required /></label>
          <label className={styles.field}><span>Description <small>optional</small></span><textarea className="textInput" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What are you investigating?" rows={3} /></label>
        </section>
        <section className={styles.formPanel} aria-labelledby="source-heading">
          <div className={styles.sourceHeading}><div><h2 id="source-heading">Workspace source</h2><p>Select a folder to import the full application tree, or add one or more files for a smaller investigation.</p></div><FolderOpen size={25} aria-hidden="true" /></div>
          <div className={styles.sourceActions}>
            <label className="primaryButton"><FolderOpen size={16} /> Choose project folder<input ref={directoryInput} type="file" multiple onChange={(event) => choose(event.target.files)} className={styles.hiddenInput} /></label>
            <label className="secondaryButton"><Upload size={16} /> Add files<input ref={fileInput} type="file" multiple onChange={(event) => choose(event.target.files)} className={styles.hiddenInput} /></label>
          </div>
          {selection && <div className={styles.selectionPreview}><strong>{selection.rootName}</strong><span>{selection.files.length.toLocaleString()} files · {formatBytes(selection.totalBytes)}</span><small>Relative paths will be stored; the local absolute path is never sent.</small></div>}
          {selectionError && <p className={styles.formError} role="alert">{selectionError}</p>}
          {importError && <p className={styles.formError} role="alert">{importError}</p>}
          {progress && <div className={styles.importProgress} aria-live="polite"><div><span>{progress.phase === 'UPLOADING' ? `Uploading ${progress.currentPath || ''}` : progress.phase}</span><strong>{progressPercent}%</strong></div><div className={styles.progressTrack}><div style={{ width: `${progressPercent}%` }} /></div><small>{progress.completedFiles.toLocaleString()} / {progress.totalFiles.toLocaleString()} files · {formatBytes(progress.uploadedBytes)} / {formatBytes(progress.totalBytes)}</small></div>}
        </section>
        <div className={styles.formFooter}><button type="button" className="secondaryButton" onClick={() => router.push('/projects')} disabled={isSubmitting}>Cancel</button><button type="button" className="primaryButton" onClick={() => void createWorkspace()} disabled={isSubmitting}>{isSubmitting && <RefreshCw size={15} className={styles.spin} />}{isSubmitting ? 'Creating workspace…' : selection ? 'Create and import workspace' : 'Create workspace'}</button></div>
      </main>
    </div>
  )
}

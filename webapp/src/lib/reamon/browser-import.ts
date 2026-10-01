import { normalizeRelativePath } from './paths'

export type BrowserWorkspaceFile = File & { webkitRelativePath?: string }

export interface WorkspaceSelectionFile {
  file: BrowserWorkspaceFile
  relativePath: string
  size: number
  lastModified: number | null
}

export interface WorkspaceSelection {
  rootName: string
  files: WorkspaceSelectionFile[]
  totalBytes: number
}

export interface ImportProgress {
  phase: 'INVENTORY' | 'UPLOADING' | 'FINALIZING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  completedFiles: number
  totalFiles: number
  uploadedBytes: number
  totalBytes: number
  currentPath: string
  failedPaths: string[]
}

export class WorkspaceImportCancelledError extends Error {
  readonly importId: string | undefined

  constructor(importId?: string) {
    super('Workspace import cancelled')
    this.name = 'WorkspaceImportCancelledError'
    this.importId = importId
  }
}

function pathParts(file: BrowserWorkspaceFile): string[] {
  const raw = file.webkitRelativePath?.trim() || file.name
  return raw.replaceAll('\\', '/').split('/').filter(Boolean)
}

export function selectionFromFiles(input: FileList | File[]): WorkspaceSelection {
  const files = Array.from(input as ArrayLike<BrowserWorkspaceFile>, (file) => file)
  if (!files.length) throw new Error('Choose a folder or file first')

  const firstParts = pathParts(files[0])
  const hasDirectoryRoot = firstParts.length > 1
  const rootName = firstParts[0]
  const seen = new Set<string>()
  const selectionFiles = files.map((file) => {
    const parts = pathParts(file)
    if (hasDirectoryRoot && parts[0] !== rootName) {
      throw new Error('Select files from one folder at a time')
    }
    const relativePath = normalizeRelativePath(hasDirectoryRoot ? parts.slice(1).join('/') : parts.join('/'))
    if (seen.has(relativePath)) throw new Error(`Duplicate selected path: ${relativePath}`)
    seen.add(relativePath)
    return {
      file,
      relativePath,
      size: file.size,
      lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null,
    }
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  return {
    rootName,
    files: selectionFiles,
    totalBytes: selectionFiles.reduce((sum, entry) => sum + entry.size, 0),
  }
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export async function runWorkspaceImport(options: {
  projectId: string
  selection: WorkspaceSelection
  importId?: string
  completedPaths?: Set<string>
  concurrency?: number
  signal?: AbortSignal
  onProgress?: (progress: ImportProgress) => void
}): Promise<{ importId: string; failedPaths: string[] }> {
  const { projectId, selection, onProgress, signal } = options
  let importId = options.importId
  const completedPaths = options.completedPaths || new Set<string>()
  const failedPaths: string[] = []
  const totalFiles = selection.files.length
  const totalBytes = selection.totalBytes
  let completedFiles = selection.files.filter((entry) => completedPaths.has(entry.relativePath)).length
  let uploadedBytes = selection.files.filter((entry) => completedPaths.has(entry.relativePath)).reduce((sum, entry) => sum + entry.size, 0)
  const emit = (phase: ImportProgress['phase'], currentPath = '') => onProgress?.({ phase, completedFiles, totalFiles, uploadedBytes, totalBytes, currentPath, failedPaths: [...failedPaths] })
  const throwIfCancelled = () => {
    if (signal?.aborted) {
      emit('CANCELLED')
      throw new WorkspaceImportCancelledError(importId)
    }
  }

  if (!importId) {
    throwIfCancelled()
    emit('INVENTORY')
    const response = await fetch(`/api/projects/${projectId}/imports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rootName: selection.rootName,
        sourceType: 'BROWSER_DIRECTORY',
        files: selection.files.map(({ relativePath, size, lastModified }) => ({ relativePath, size, lastModified })),
      }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Unable to prepare workspace import')
    importId = data.id as string
  }

  emit('UPLOADING')
  let cursor = 0
  const concurrency = Math.max(1, Math.min(options.concurrency || 3, 6))
  const uploadOne = async (entry: WorkspaceSelectionFile) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        throwIfCancelled()
        const body = new FormData()
        body.set('file', entry.file)
        body.set('relativePath', entry.relativePath)
        const response = await fetch(`/api/projects/${projectId}/imports/${importId}/artifacts`, { method: 'POST', body, signal })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || `Upload failed for ${entry.relativePath}`)
        completedPaths.add(entry.relativePath)
        completedFiles += 1
        uploadedBytes += entry.size
        emit('UPLOADING', entry.relativePath)
        return
      } catch (error) {
        if (signal?.aborted || error instanceof WorkspaceImportCancelledError) throw new WorkspaceImportCancelledError(importId)
        if (attempt === 1) {
          failedPaths.push(entry.relativePath)
          emit('FAILED', entry.relativePath)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
  }

  const worker = async () => {
    while (cursor < selection.files.length) {
      throwIfCancelled()
      const entry = selection.files[cursor]
      cursor += 1
      if (completedPaths.has(entry.relativePath)) continue
      await uploadOne(entry)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, totalFiles || 1) }, () => worker()))

  throwIfCancelled()
  emit(failedPaths.length ? 'FAILED' : 'FINALIZING')
  if (!failedPaths.length) {
    const response = await fetch(`/api/projects/${projectId}/imports/${importId}/finalize`, { method: 'POST', signal })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Unable to finalize workspace import')
    emit('COMPLETED')
  } else {
    // Persist the partial state. The server marks it FAILED with missing paths;
    // a retry can upload those paths against the same import id.
    await fetch(`/api/projects/${projectId}/imports/${importId}/finalize`, { method: 'POST' }).catch(() => {})
  }
  return { importId, failedPaths }
}

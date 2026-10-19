import { normalizeRelativePath } from './paths'

export interface ImportManifestEntry {
  relativePath: string
  size: number
  lastModified: number | null
}

export interface WorkspaceImportLimits {
  maxFiles: null
  maxImportBytes: number | null
  maxArtifactBytes: number | null
}

export function workspaceImportLimits(): WorkspaceImportLimits {
  return {
    maxFiles: null,
    maxImportBytes: null,
    maxArtifactBytes: null,
  }
}

export function parseImportManifest(value: unknown): { entries: ImportManifestEntry[]; totalBytes: number } {
  if (!Array.isArray(value) || value.length === 0) throw new Error('At least one file is required')

  const seen = new Set<string>()
  let totalBytes = 0
  const entries = value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid import manifest entry')
    const candidate = raw as Record<string, unknown>
    const relativePath = normalizeRelativePath(String(candidate.relativePath || ''))
    if (seen.has(relativePath)) throw new Error(`Duplicate path in import manifest: ${relativePath}`)
    seen.add(relativePath)
    const size = Number(candidate.size)
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid or oversized artifact: ${relativePath}`)
    }
    totalBytes += size
    if (!Number.isSafeInteger(totalBytes)) throw new Error('Import size exceeds the supported file-size range')
    const lastModified = candidate.lastModified == null ? null : Number(candidate.lastModified)
    return {
      relativePath,
      size,
      lastModified: Number.isFinite(lastModified) ? lastModified : null,
    }
  })
  return { entries, totalBytes }
}

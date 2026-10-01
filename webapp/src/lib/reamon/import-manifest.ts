import { normalizeRelativePath } from './paths'

export interface ImportManifestEntry {
  relativePath: string
  size: number
  lastModified: number | null
}

const DEFAULT_MAX_FILES = 50_000
const DEFAULT_MAX_IMPORT_BYTES = 8 * 1024 * 1024 * 1024
const DEFAULT_MAX_ARTIFACT_BYTES = 512 * 1024 * 1024

function configuredPositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

export function workspaceImportLimits() {
  return {
    maxFiles: configuredPositiveInt('REAMON_MAX_IMPORT_FILES', DEFAULT_MAX_FILES),
    maxImportBytes: configuredPositiveInt('REAMON_MAX_IMPORT_BYTES', DEFAULT_MAX_IMPORT_BYTES),
    maxArtifactBytes: configuredPositiveInt('REAMON_MAX_ARTIFACT_BYTES', DEFAULT_MAX_ARTIFACT_BYTES),
  }
}

export function parseImportManifest(value: unknown): { entries: ImportManifestEntry[]; totalBytes: number } {
  const { maxFiles, maxImportBytes, maxArtifactBytes } = workspaceImportLimits()
  if (!Array.isArray(value) || value.length === 0) throw new Error('At least one file is required')
  if (value.length > maxFiles) throw new Error(`Import exceeds the ${maxFiles.toLocaleString()} file limit`)

  const seen = new Set<string>()
  let totalBytes = 0
  const entries = value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid import manifest entry')
    const candidate = raw as Record<string, unknown>
    const relativePath = normalizeRelativePath(String(candidate.relativePath || ''))
    if (seen.has(relativePath)) throw new Error(`Duplicate path in import manifest: ${relativePath}`)
    seen.add(relativePath)
    const size = Number(candidate.size)
    if (!Number.isSafeInteger(size) || size < 0 || size > maxArtifactBytes) {
      throw new Error(`Invalid or oversized artifact: ${relativePath}`)
    }
    totalBytes += size
    if (totalBytes > maxImportBytes) throw new Error('Import exceeds the configured byte limit')
    const lastModified = candidate.lastModified == null ? null : Number(candidate.lastModified)
    return {
      relativePath,
      size,
      lastModified: Number.isFinite(lastModified) ? lastModified : null,
    }
  })
  return { entries, totalBytes }
}

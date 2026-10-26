import path from 'node:path'
import { rm, statfs } from 'node:fs/promises'

export class InvalidArtifactStoragePathError extends Error {
  constructor(message = 'Invalid artifact storage path') {
    super(message)
    this.name = 'InvalidArtifactStoragePathError'
  }
}

export function artifactRoot(): string {
  return path.resolve(process.env.REAMON_ARTIFACTS_PATH || path.join(process.cwd(), 'data', 'reamon-artifacts'))
}

/** Resolve one import's staging directory without allowing IDs to escape `.uploads`. */
export function resolveStagedImportDirectory(projectId: string, importId: string): string {
  if (!projectId || !importId || projectId.includes('\u0000') || importId.includes('\u0000')) {
    throw new InvalidArtifactStoragePathError('Invalid staged import directory')
  }
  const root = path.resolve(artifactRoot(), '.uploads')
  const directory = path.resolve(root, projectId, importId)
  const relative = path.relative(root, directory)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
    || path.dirname(relative) !== projectId || path.basename(relative) !== importId) {
    throw new InvalidArtifactStoragePathError('Invalid staged import directory')
  }
  return directory
}

export async function removeStagedImport(projectId: string, importId: string): Promise<void> {
  await rm(resolveStagedImportDirectory(projectId, importId), { recursive: true, force: true })
}

export interface ArtifactVolumeCapacity {
  available: boolean
  totalBytes: string | null
  usedBytes: string | null
  freeBytes: string | null
  usedPercent: number | null
  checkedAt: string
}

/** Return shared artifact-volume capacity without walking files or imposing a quota. */
export async function getArtifactVolumeCapacity(): Promise<ArtifactVolumeCapacity> {
  const checkedAt = new Date().toISOString()
  try {
    const stats = await statfs(artifactRoot(), { bigint: true })
    const total = stats.blocks * stats.bsize
    const free = stats.bavail * stats.bsize
    const available = total > 0n
    const boundedFree = free < 0n ? 0n : free > total ? total : free
    const used = available ? total - boundedFree : 0n
    return {
      available,
      totalBytes: available ? total.toString() : null,
      usedBytes: available ? used.toString() : null,
      freeBytes: available ? boundedFree.toString() : null,
      usedPercent: available ? Number((used * 10000n) / total) / 100 : null,
      checkedAt,
    }
  } catch {
    return { available: false, totalBytes: null, usedBytes: null, freeBytes: null, usedPercent: null, checkedAt }
  }
}

/** Resolve a database storage key without allowing it to escape the artifact volume. */
export function resolveArtifactStoragePath(storagePath: string): string {
  if (typeof storagePath !== 'string' || !storagePath.trim() || storagePath.includes('\u0000')) {
    throw new InvalidArtifactStoragePathError()
  }

  const root = artifactRoot()
  const absolute = path.resolve(root, storagePath)
  const relative = path.relative(root, absolute)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new InvalidArtifactStoragePathError()
  }
  return absolute
}

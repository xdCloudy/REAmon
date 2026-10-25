import path from 'node:path'
import { statfs } from 'node:fs/promises'

export class InvalidArtifactStoragePathError extends Error {
  constructor(message = 'Invalid artifact storage path') {
    super(message)
    this.name = 'InvalidArtifactStoragePathError'
  }
}

export function artifactRoot(): string {
  return path.resolve(process.env.REAMON_ARTIFACTS_PATH || path.join(process.cwd(), 'data', 'reamon-artifacts'))
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

const STORAGE_FULL_CODES = new Set(['ENOSPC', 'EDQUOT'])

export const ARTIFACT_STORAGE_FULL_MESSAGE = 'Artifact storage is full; free space or increase the available volume capacity, then retry'

export function isArtifactStorageFullError(error: unknown): boolean {
  const visited = new Set<object>()
  let current: unknown = error

  for (let depth = 0; depth < 5 && current && typeof current === 'object' && !visited.has(current); depth += 1) {
    visited.add(current)
    if ('code' in current && typeof current.code === 'string' && STORAGE_FULL_CODES.has(current.code)) return true
    current = 'cause' in current ? current.cause : null
  }

  return false
}

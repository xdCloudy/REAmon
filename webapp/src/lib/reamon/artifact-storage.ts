import path from 'node:path'

export class InvalidArtifactStoragePathError extends Error {
  constructor(message = 'Invalid artifact storage path') {
    super(message)
    this.name = 'InvalidArtifactStoragePathError'
  }
}

export function artifactRoot(): string {
  return path.resolve(process.env.REAMON_ARTIFACTS_PATH || path.join(process.cwd(), 'data', 'reamon-artifacts'))
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

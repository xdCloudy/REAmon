import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { normalizeRelativePath } from './paths'
import { workspaceImportLimits, type ImportManifestEntry } from './import-manifest'

export const SERVER_DIRECTORY_SOURCE_TYPE = 'SERVER_DIRECTORY'

type ServerSourceErrorCode =
  | 'CONFIGURATION'
  | 'INVALID_PATH'
  | 'UNAVAILABLE'
  | 'SYMLINK'
  | 'SPECIAL_FILE'
  | 'LIMIT'
  | 'CHANGED'

export class ServerSourceError extends Error {
  readonly code: ServerSourceErrorCode
  readonly status: number

  constructor(code: ServerSourceErrorCode, message: string, status = 400) {
    super(message)
    this.name = 'ServerSourceError'
    this.code = code
    this.status = status
  }
}

function configuredRootNames(): string[] {
  return (process.env.REAMON_SERVER_SOURCE_ROOTS || '')
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function allowedRoots(): Promise<string[]> {
  const configured = configuredRootNames()
  if (!configured.length) {
    throw new ServerSourceError('CONFIGURATION', 'Server-mounted sources are not configured')
  }

  const roots: string[] = []
  for (const configuredRoot of configured) {
    if (!path.isAbsolute(configuredRoot) || configuredRoot.includes('\u0000')) continue
    try {
      const resolved = await realpath(configuredRoot)
      const details = await lstat(resolved)
      if (details.isDirectory()) roots.push(resolved)
    } catch {
      // A deployment may configure several mounts and bring them online at
      // different times. Ignore an unavailable entry and fail closed below if
      // no configured mount can be used.
    }
  }
  if (!roots.length) {
    throw new ServerSourceError('UNAVAILABLE', 'Configured server-mounted sources are unavailable', 503)
  }
  return roots
}

async function resolveSourceDirectory(sourcePath: string): Promise<string> {
  if (!path.isAbsolute(sourcePath) || sourcePath.includes('\u0000')) {
    throw new ServerSourceError('INVALID_PATH', 'Server source path must be absolute')
  }

  const roots = await allowedRoots()
  let resolved: string
  try {
    resolved = await realpath(sourcePath)
  } catch {
    throw new ServerSourceError('UNAVAILABLE', 'Server source is unavailable', 409)
  }
  let details
  try {
    details = await lstat(resolved)
  } catch {
    throw new ServerSourceError('UNAVAILABLE', 'Server source is unavailable', 409)
  }
  if (!details.isDirectory()) throw new ServerSourceError('INVALID_PATH', 'Server source must be a directory')
  if (!roots.some((root) => isWithin(root, resolved))) {
    throw new ServerSourceError('INVALID_PATH', 'Server source path is not allowlisted')
  }
  return resolved
}

function sourceRelativePath(sourceRoot: string, absolutePath: string): string {
  const relative = path.relative(sourceRoot, absolutePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ServerSourceError('INVALID_PATH', 'Server source path is not allowlisted')
  }
  return normalizeRelativePath(relative)
}

async function inspectRegularFile(absolutePath: string, relativePath: string): Promise<ImportManifestEntry> {
  let details
  try {
    details = await lstat(absolutePath)
  } catch {
    throw new ServerSourceError('UNAVAILABLE', 'Server source changed during inventory', 409)
  }
  if (details.isSymbolicLink()) throw new ServerSourceError('SYMLINK', 'Symbolic links are not supported in server-mounted imports')
  if (!details.isFile()) throw new ServerSourceError('SPECIAL_FILE', 'Server-mounted imports support regular files only')

  const size = details.size
  const { maxArtifactBytes } = workspaceImportLimits()
  if (!Number.isSafeInteger(size) || size > maxArtifactBytes) {
    throw new ServerSourceError('LIMIT', `Server source exceeds the ${Math.round(maxArtifactBytes / 1024 / 1024)} MiB artifact limit`)
  }
  const lastModified = Number.isFinite(details.mtimeMs) ? Math.trunc(details.mtimeMs) : null
  return { relativePath, size, lastModified }
}

export async function inventoryServerSource(sourcePath: string): Promise<{ sourcePath: string; entries: ImportManifestEntry[]; totalBytes: number }> {
  const sourceRoot = await resolveSourceDirectory(sourcePath)
  const { maxFiles, maxImportBytes } = workspaceImportLimits()
  const entries: ImportManifestEntry[] = []
  const pending = [sourceRoot]

  while (pending.length) {
    const current = pending.pop() as string
    let children
    try {
      children = await readdir(current, { withFileTypes: true })
    } catch {
      throw new ServerSourceError('UNAVAILABLE', 'Server source changed during inventory', 409)
    }
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

    for (const child of children) {
      const absolutePath = path.join(current, child.name)
      const relativePath = sourceRelativePath(sourceRoot, absolutePath)
      let details
      try {
        details = await lstat(absolutePath)
      } catch {
        throw new ServerSourceError('UNAVAILABLE', 'Server source changed during inventory', 409)
      }
      if (details.isSymbolicLink()) throw new ServerSourceError('SYMLINK', 'Symbolic links are not supported in server-mounted imports')
      if (details.isDirectory()) {
        pending.push(absolutePath)
        continue
      }
      const entry = await inspectRegularFile(absolutePath, relativePath)
      entries.push(entry)
      if (entries.length > maxFiles) throw new ServerSourceError('LIMIT', `Import exceeds the ${maxFiles.toLocaleString()} file limit`)
    }
  }

  entries.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0)
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
  if (totalBytes > maxImportBytes) throw new ServerSourceError('LIMIT', 'Import exceeds the configured byte limit')
  return { sourcePath: sourceRoot, entries, totalBytes }
}

async function resolveSourceFile(sourceRoot: string, relativePath: string): Promise<string> {
  const normalized = normalizeRelativePath(relativePath)
  let current = sourceRoot
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment)
    let details
    try {
      details = await lstat(current)
    } catch {
      throw new ServerSourceError('UNAVAILABLE', 'Server source file is unavailable', 409)
    }
    if (details.isSymbolicLink()) throw new ServerSourceError('SYMLINK', 'Symbolic links are not supported in server-mounted imports')
    if (segment !== normalized.split('/').at(-1) && !details.isDirectory()) {
      throw new ServerSourceError('INVALID_PATH', 'Server source path is not a file')
    }
  }
  const details = await lstat(current)
  if (!details.isFile()) throw new ServerSourceError('SPECIAL_FILE', 'Server-mounted imports support regular files only')
  return current
}

export async function readServerSourceArtifact(sourcePath: string, relativePath: string, expectedSize?: number): Promise<Uint8Array> {
  const sourceRoot = await resolveSourceDirectory(sourcePath)
  const absolutePath = await resolveSourceFile(sourceRoot, relativePath)
  const { maxArtifactBytes } = workspaceImportLimits()
  let before
  try {
    before = await lstat(absolutePath)
  } catch {
    throw new ServerSourceError('UNAVAILABLE', 'Server source file is unavailable', 409)
  }
  if (before.size > maxArtifactBytes) {
    throw new ServerSourceError('LIMIT', 'Server source exceeds the configured artifact limit')
  }
  if (expectedSize != null && before.size !== expectedSize) {
    throw new ServerSourceError('CHANGED', 'Server source file changed after inventory', 409)
  }

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(absolutePath))
  } catch {
    throw new ServerSourceError('UNAVAILABLE', 'Server source file is unavailable', 409)
  }
  let after
  try {
    after = await lstat(absolutePath)
  } catch {
    throw new ServerSourceError('CHANGED', 'Server source file changed during import', 409)
  }
  if (!after.isFile() || after.size !== bytes.byteLength || after.size !== before.size) {
    throw new ServerSourceError('CHANGED', 'Server source file changed during import', 409)
  }
  return bytes
}

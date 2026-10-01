/** Logical workspace paths are metadata, never server filesystem paths. */

export class InvalidWorkspacePathError extends Error {
  constructor(message = 'Invalid workspace-relative path') {
    super(message)
    this.name = 'InvalidWorkspacePathError'
  }
}

export function normalizeRelativePath(input: string): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new InvalidWorkspacePathError('Workspace path is empty')
  }

  const raw = input.trim().replaceAll('\\', '/')
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.includes('\u0000')) {
    throw new InvalidWorkspacePathError('Absolute paths are not allowed')
  }

  const segments = raw.split('/').filter(Boolean)
  if (!segments.length || segments.some((segment) => segment === '..' || /[\u0000-\u001f\u007f]/.test(segment))) {
    throw new InvalidWorkspacePathError('Path traversal or control characters are not allowed')
  }

  const normalized = segments.filter((segment) => segment !== '.').join('/')
  if (!normalized || normalized === '.') {
    throw new InvalidWorkspacePathError('Invalid workspace-relative path')
  }
  return normalized
}

export function parentPathOf(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath)
  const separator = normalized.lastIndexOf('/')
  return separator === -1 ? '' : normalized.slice(0, separator)
}

export function normalizeRootName(input: string): string {
  const value = input.trim()
  if (!value || value === '.' || value === '..' || /[\\/\u0000-\u001f\u007f]/.test(value)) {
    throw new InvalidWorkspacePathError('Workspace root name is invalid')
  }
  return value.slice(0, 255)
}

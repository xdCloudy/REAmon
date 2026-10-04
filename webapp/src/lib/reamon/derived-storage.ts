import { rm } from 'node:fs/promises'
import path from 'node:path'

export class InvalidDerivedArtifactPathError extends Error {
  constructor() {
    super('Invalid derived artifact path')
    this.name = 'InvalidDerivedArtifactPathError'
  }
}

export function derivedArtifactRoot(): string {
  return path.resolve(process.env.REAMON_DERIVED_PATH || path.join(process.cwd(), 'data', 'reamon-derived'))
}

export function resolveDerivedArtifactPath(relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath.trim() || relativePath.includes('\u0000')) {
    throw new InvalidDerivedArtifactPathError()
  }
  const root = derivedArtifactRoot()
  const absolute = path.resolve(root, relativePath)
  const relative = path.relative(root, absolute)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new InvalidDerivedArtifactPathError()
  }
  return absolute
}

export async function removeDerivedArtifactProject(projectId: string): Promise<void> {
  const projectPath = resolveDerivedArtifactPath(projectId)
  await rm(projectPath, { recursive: true, force: true })
}

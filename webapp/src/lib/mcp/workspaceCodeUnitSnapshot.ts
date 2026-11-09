import { createHash } from 'node:crypto'

export interface WorkspaceCodeUnitSourceSnapshot {
  codeUnitId: string
  artifactId: string | null
  artifactSha256: string | null
  decompiledSourceSha256: string | null
  disassemblySha256: string | null
  maintainedSourceSha256: string | null
  savedDraftSha256: string | null
}

export function hashWorkspaceCodeUnitSourceSnapshot(snapshot: WorkspaceCodeUnitSourceSnapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

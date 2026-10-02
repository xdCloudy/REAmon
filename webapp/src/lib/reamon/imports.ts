export type ImportComparisonMode = 'MANIFEST' | 'HASH'

export interface ImportComparisonEntry {
  relativePath: string
  size?: number
  lastModified?: number | null
  sha256?: string
}

export interface WorkspaceImportComparison {
  mode: ImportComparisonMode
  previousImportId: string | null
  addedCount: number
  changedCount: number
  removedCount: number
  unchangedCount: number
  addedPaths: string[]
  changedPaths: string[]
  removedPaths: string[]
  unchangedPaths: string[]
}

export interface WorkspaceImportState {
  id: string
  rootName: string
  status: string
  rootTargetId?: string | null
  createdAt?: Date | string
}

const MAX_SAMPLE_PATHS = 200

/**
 * Select the import rows that represent the current workspace view. Refreshes
 * are additive for audit/history, but the explorer must not render the same
 * logical path from every prior snapshot. A completed snapshot remains the
 * active view while a newer partial import is still in progress; if no
 * completed snapshot exists, the newest partial/cancelled snapshot is visible
 * so operators can inspect and resume it.
 */
export function activeWorkspaceImportIds(imports: WorkspaceImportState[]): Set<string> {
  const byRoot = new Map<string, WorkspaceImportState[]>()
  for (const workspaceImport of imports) {
    const group = byRoot.get(workspaceImport.rootName) || []
    group.push(workspaceImport)
    byRoot.set(workspaceImport.rootName, group)
  }

  const active = new Set<string>()
  for (const group of byRoot.values()) {
    const ordered = [...group].sort((left, right) => {
      if (!left.createdAt || !right.createdAt) return 0
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    })
    const selected = ordered.find((workspaceImport) => workspaceImport.status === 'COMPLETED') || ordered[0]
    if (selected) active.add(selected.id)
  }
  return active
}

export function activeWorkspaceTargetIds(
  targets: Array<{ id: string; targetType: string; parentTargetId: string | null }>,
  activeRootTargetIds: Set<string>,
  activeArtifactTargetIds: Set<string>,
  hasImportHistory: boolean,
): Set<string> {
  if (!hasImportHistory) return new Set(targets.map((target) => target.id))

  const visible = new Set<string>(activeRootTargetIds)
  for (const target of targets) if (activeArtifactTargetIds.has(target.id)) visible.add(target.id)
  for (const target of targets) {
    // Targets from the inherited RedAmon model have no import parent and must
    // continue to render while the project is being migrated.
    if (!target.parentTargetId && target.targetType !== 'DIRECTORY') visible.add(target.id)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const target of targets) {
      // Logical targets created by an import are usually direct children of
      // its root. Keep walking so future nested target relationships remain
      // safe even if rows arrive in a different order.
      if (target.parentTargetId && visible.has(target.parentTargetId) && !visible.has(target.id)) {
        visible.add(target.id)
        changed = true
      }
    }
  }
  return visible
}

function sameContent(previous: ImportComparisonEntry, current: ImportComparisonEntry, mode: ImportComparisonMode): boolean {
  if (mode === 'HASH' && previous.sha256 && current.sha256) return previous.sha256 === current.sha256
  return previous.size === current.size && previous.lastModified === current.lastModified
}

export function compareWorkspaceImports(
  previous: ImportComparisonEntry[],
  current: ImportComparisonEntry[],
  options: { mode: ImportComparisonMode; previousImportId?: string | null },
): WorkspaceImportComparison {
  const previousByPath = new Map(previous.map((entry) => [entry.relativePath, entry]))
  const currentByPath = new Map(current.map((entry) => [entry.relativePath, entry]))
  const addedPaths: string[] = []
  const changedPaths: string[] = []
  const removedPaths: string[] = []
  const unchangedPaths: string[] = []

  for (const currentEntry of currentByPath.values()) {
    const previousEntry = previousByPath.get(currentEntry.relativePath)
    if (!previousEntry) addedPaths.push(currentEntry.relativePath)
    else if (sameContent(previousEntry, currentEntry, options.mode)) unchangedPaths.push(currentEntry.relativePath)
    else changedPaths.push(currentEntry.relativePath)
  }
  for (const previousEntry of previousByPath.values()) {
    if (!currentByPath.has(previousEntry.relativePath)) removedPaths.push(previousEntry.relativePath)
  }

  const sample = (paths: string[]) => paths.sort((left, right) => left.localeCompare(right)).slice(0, MAX_SAMPLE_PATHS)
  return {
    mode: options.mode,
    previousImportId: options.previousImportId || null,
    addedCount: addedPaths.length,
    changedCount: changedPaths.length,
    removedCount: removedPaths.length,
    unchangedCount: unchangedPaths.length,
    addedPaths: sample(addedPaths),
    changedPaths: sample(changedPaths),
    removedPaths: sample(removedPaths),
    unchangedPaths: sample(unchangedPaths),
  }
}

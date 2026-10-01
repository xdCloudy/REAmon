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

const MAX_SAMPLE_PATHS = 200

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

/** Stable, JSON-safe representation for project-wide REAmon observations. */
export interface ProjectObservationExportRow {
  id: string
  projectId: string
  taskId: string | null
  targetId: string | null
  artifactId: string | null
  kind: string
  type: string
  stableKey: string
  canonicalKey: string
  label: string | null
  source: string
  relation: string | null
  fromKey: string | null
  toKey: string | null
  fromCanonicalKey: string | null
  toCanonicalKey: string | null
  attributes: unknown
  isPending: boolean
  createdAt: Date
  updatedAt: Date
}

export interface SerializedProjectObservation extends Omit<ProjectObservationExportRow, 'createdAt' | 'updatedAt'> {
  createdAt: string
  updatedAt: string
}

/**
 * Preserve stable identity, provenance links, pending state and provider
 * evidence while converting Prisma timestamps to portable JSON values.
 */
export function serializeProjectObservations(
  rows: ProjectObservationExportRow[],
): SerializedProjectObservation[] {
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }))
}

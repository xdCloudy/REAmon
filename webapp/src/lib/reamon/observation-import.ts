import type { Prisma } from '@prisma/client'

export const MAX_IMPORTED_OBSERVATIONS = 50_000
const MAX_OBSERVATION_ATTRIBUTE_BYTES = 64 * 1024

export interface ImportedObservationRow {
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
  attributes: Prisma.InputJsonValue
  isPending: boolean
  createdAt: Date
  updatedAt: Date
}

export interface PreparedObservationImport {
  rows: ImportedObservationRow[]
  skipped: number
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function optionalString(value: unknown, max = 1000): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function importedDate(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string') return fallback
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? fallback : date
}

/**
 * Validate observation rows from an untrusted project archive. Task, target,
 * and artifact foreign keys cannot be reused because those rows are not part of
 * this archive format; their old ids and the observation's source id are
 * retained as import provenance inside attributes while active foreign-key
 * columns stay null.
 */
export function prepareObservationImport(value: unknown, now = new Date()): PreparedObservationImport {
  if (!Array.isArray(value)) return { rows: [], skipped: 0 }
  let skipped = Math.max(0, value.length - MAX_IMPORTED_OBSERVATIONS)
  const candidates = value.slice(0, MAX_IMPORTED_OBSERVATIONS)
  const seen = new Set<string>()
  const rows: ImportedObservationRow[] = []

  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped++
      continue
    }
    const row = raw as Record<string, unknown>
    const kind = boundedString(row.kind, 40)
    const type = boundedString(row.type, 120)
    const stableKey = boundedString(row.stableKey, 1000)
    const canonicalKey = boundedString(row.canonicalKey, 1000)
    const source = boundedString(row.source, 200)
    const attributes = row.attributes && typeof row.attributes === 'object' && !Array.isArray(row.attributes)
      ? row.attributes as Record<string, unknown>
      : null
    if (!kind || !type || !stableKey || !canonicalKey || !source || !attributes) {
      skipped++
      continue
    }
    const identity = `${source}\u0000${stableKey}`
    if (seen.has(identity)) {
      skipped++
      continue
    }
    let attributesBytes: number
    try {
      attributesBytes = Buffer.byteLength(JSON.stringify(attributes), 'utf8')
    } catch {
      skipped++
      continue
    }
    if (attributesBytes > MAX_OBSERVATION_ATTRIBUTE_BYTES) {
      skipped++
      continue
    }
    seen.add(identity)
    const originalReferences = {
      observationId: optionalString(row.id, 200),
      projectId: optionalString(row.projectId, 200),
      taskId: optionalString(row.taskId, 200),
      targetId: optionalString(row.targetId, 200),
      artifactId: optionalString(row.artifactId, 200),
    }
    const hasOriginalReference = Object.values(originalReferences).some(Boolean)
    const safeAttributes = { ...attributes }
    delete safeAttributes.importOrigin
    rows.push({
      kind,
      type,
      stableKey,
      canonicalKey,
      label: optionalString(row.label, 1000),
      source,
      relation: optionalString(row.relation, 120),
      fromKey: optionalString(row.fromKey),
      toKey: optionalString(row.toKey),
      fromCanonicalKey: optionalString(row.fromCanonicalKey),
      toCanonicalKey: optionalString(row.toCanonicalKey),
      attributes: {
        ...safeAttributes,
        ...(hasOriginalReference ? { importOrigin: originalReferences } : {}),
      } as Prisma.InputJsonValue,
      isPending: row.isPending === true,
      createdAt: importedDate(row.createdAt, now),
      updatedAt: importedDate(row.updatedAt, now),
    })
  }
  return { rows, skipped }
}

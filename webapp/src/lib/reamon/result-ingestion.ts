import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type {
  ObservationAttributes,
  ObservationKind,
  ToolObservation,
} from './types'

export const MAX_OBSERVATIONS_PER_RESULT = 500
export const MAX_CODE_UNITS_PER_RESULT = 100000
export const MAX_OBSERVATION_ATTRIBUTES = 64
export const MAX_FINDINGS_PER_RESULT = 200
const OBSERVATION_UPSERT_BATCH_SIZE = 250

const OBSERVATION_KINDS = new Set<ObservationKind>(['entity', 'relationship', 'fact'])
const FINDING_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null
}

function asAttributes(value: unknown, preferredKeys: readonly string[] = []): ObservationAttributes {
  const record = asRecord(value)
  if (!record) return {}
  const attributes: ObservationAttributes = {}
  const preferred = preferredKeys.flatMap((key) => Object.hasOwn(record, key) ? [[key, record[key]] as const] : [])
  const preferredSet = new Set(preferredKeys)
  const entries = [...preferred, ...Object.entries(record).filter(([key]) => !preferredSet.has(key))]
  for (const [key, rawValue] of entries.slice(0, MAX_OBSERVATION_ATTRIBUTES)) {
    const boundedKey = boundedString(key, 128)
    if (!boundedKey) continue
    if (rawValue === null || typeof rawValue === 'string' || typeof rawValue === 'boolean') {
      attributes[boundedKey] = typeof rawValue === 'string'
        ? rawValue.slice(0, boundedKey === 'structuredBytecode' ? 200_000 : 4000)
        : rawValue
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      attributes[boundedKey] = rawValue
    }
  }
  return attributes
}

function identityHint(observation: ToolObservation): string | null {
  if (observation.kind === 'relationship') return null
  const hinted = [
    observation.attributes.identityKey,
    observation.attributes.identity,
    observation.attributes.canonicalKey,
    observation.attributes.qualifiedName,
  ].find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  if (hinted) return hinted
  if (observation.type.toLowerCase() === 'string' && typeof observation.attributes.value === 'string') {
    return observation.attributes.value
  }
  return null
}

/**
 * Resolve a provider observation to a graph identity. Explicit identity hints
 * are intentionally provider-independent; observations without one retain the
 * old source-scoped behavior and cannot accidentally merge unrelated entities.
 */
export function canonicalKeyForObservation(source: string, observation: ToolObservation): string {
  const hint = identityHint(observation)
  if (!hint) return `source:${source}:${observation.key}`
  const normalized = hint.trim().replace(/\s+/g, ' ').toLowerCase()
  const digest = createHash('sha256')
    .update(`${observation.type.toLowerCase()}:${normalized}`)
    .digest('hex')
    .slice(0, 32)
  return `identity:${observation.type.toLowerCase()}:${digest}`
}

function normalizeObservation(value: unknown): ToolObservation | null {
  const record = asRecord(value)
  if (!record) return null
  const kind = boundedString(record.kind, 32) as ObservationKind | null
  const type = boundedString(record.type, 256)
  const key = boundedString(record.key, 256)
  if (!kind || !OBSERVATION_KINDS.has(kind) || !type || !key) return null

  const observation: ToolObservation = {
    kind,
    type,
    key,
    label: boundedString(record.label, 500) || undefined,
    relation: boundedString(record.relation, 256) || undefined,
    fromKey: boundedString(record.fromKey, 256) || undefined,
    toKey: boundedString(record.toKey, 256) || undefined,
    fromCanonicalKey: boundedString(record.fromCanonicalKey, 512) || undefined,
    toCanonicalKey: boundedString(record.toCanonicalKey, 512) || undefined,
    attributes: asAttributes(record.attributes, type.toLowerCase() === 'code_unit' ? [
      'identity',
      'codeArtifactId',
      'relativePath',
      'language',
      'representation',
      'representationSemantics',
      'roundTripAvailable',
      'roundTripByteIdentical',
      'roundTripArtifactId',
      'roundTripSha256',
      'roundTripBytes',
      'roundTripError',
      'decompiler',
      'decompilerVersion',
      'deobfuscatedArtifactId',
      'deobfuscatedArtifactSha256',
      'deobfuscationProvider',
      'deobfuscationProviderRevision',
      'deobfuscationEnabledPasses',
      'deobfuscationDisabledPasses',
      'providerRevision',
      'inputArtifactSha256',
      'codeArtifactSha256',
      'structuredBytecode',
      'structuredBytecodeSha256',
      'decompiledSourceSha256',
      'unitType',
      'qualifiedName',
      'name',
      'address',
      'sizeBytes',
    ] : []),
  }
  if (kind === 'relationship' && (!observation.fromKey || !observation.toKey)) return null
  return observation
}

export interface ParsedObservations {
  observations: ToolObservation[]
  rejected: number
}

export interface ToolFinding {
  key: string
  title: string
  description: string
  severity: string
  data: ObservationAttributes
}

export interface ParsedFindings {
  findings: ToolFinding[]
  rejected: number
}

function normalizeFinding(value: unknown): ToolFinding | null {
  const record = asRecord(value)
  if (!record) return null
  const key = boundedString(record.key, 256) || boundedString(record.fingerprint, 256)
  const title = boundedString(record.title, 500)
  if (!key || !title) return null
  const severityValue = boundedString(record.severity, 32)?.toLowerCase() || 'info'
  if (!FINDING_SEVERITIES.has(severityValue)) return null
  return {
    key,
    title,
    description: boundedString(record.description, 8000) || '',
    severity: severityValue,
    data: asAttributes(record.data),
  }
}

export function parseToolFindings(data: unknown): ParsedFindings {
  const record = asRecord(data)
  const rawFindings = record?.findings
  if (!Array.isArray(rawFindings)) return { findings: [], rejected: 0 }

  const findings: ToolFinding[] = []
  const seenKeys = new Set<string>()
  let rejected = Math.max(0, rawFindings.length - MAX_FINDINGS_PER_RESULT)
  for (const rawFinding of rawFindings.slice(0, MAX_FINDINGS_PER_RESULT)) {
    const finding = normalizeFinding(rawFinding)
    if (!finding || seenKeys.has(finding.key)) {
      rejected += 1
      continue
    }
    seenKeys.add(finding.key)
    findings.push(finding)
  }
  return { findings, rejected }
}

export function parseToolObservations(data: unknown, maxObservations = MAX_OBSERVATIONS_PER_RESULT): ParsedObservations {
  const record = asRecord(data)
  const rawObservations = record?.observations
  if (!Array.isArray(rawObservations)) return { observations: [], rejected: 0 }

  const observations: ToolObservation[] = []
  const seenKeys = new Set<string>()
  const limit = Math.max(1, Math.min(MAX_CODE_UNITS_PER_RESULT, Math.floor(maxObservations)))
  let rejected = Math.max(0, rawObservations.length - limit)
  for (const rawObservation of rawObservations.slice(0, limit)) {
    const observation = normalizeObservation(rawObservation)
    if (!observation || seenKeys.has(observation.key)) {
      rejected += 1
      continue
    }
    seenKeys.add(observation.key)
    observations.push(observation)
  }
  return { observations, rejected }
}

export interface ObservationIngestionInput {
  projectId: string
  taskId: string
  targetId: string | null
  artifactId: string | null
  source: string
  data: unknown
  maxObservations?: number
  isPending?: boolean
}

export interface ObservationIngestionSummary {
  accepted: number
  rejected: number
  findingsAccepted: number
  findingsRejected: number
}

export async function ingestToolResult(
  tx: Prisma.TransactionClient,
  input: ObservationIngestionInput,
): Promise<ObservationIngestionSummary> {
  const parsed = parseToolObservations(input.data, input.maxObservations)
  for (let offset = 0; offset < parsed.observations.length; offset += OBSERVATION_UPSERT_BATCH_SIZE) {
    const batch = parsed.observations.slice(offset, offset + OBSERVATION_UPSERT_BATCH_SIZE)
    const rows = batch.map((observation) => Prisma.sql`(
      ${`c${randomUUID().replaceAll('-', '')}`},
      ${input.projectId}, ${input.taskId}, ${input.targetId}, ${input.artifactId},
      ${observation.kind}, ${observation.type}, ${observation.key},
      ${canonicalKeyForObservation(input.source, observation)}, ${observation.label ?? null}, ${input.source},
      ${observation.relation ?? null}, ${observation.fromKey ?? null}, ${observation.toKey ?? null},
      ${observation.fromCanonicalKey ?? null}, ${observation.toCanonicalKey ?? null},
      ${JSON.stringify(observation.attributes)}::jsonb,
      ${input.isPending === true},
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )`)
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "reamon_observations" (
        "id", "project_id", "task_id", "target_id", "artifact_id", "kind", "type",
        "stable_key", "canonical_key", "label", "source", "relation", "from_key", "to_key",
        "from_canonical_key", "to_canonical_key", "attributes", "is_pending", "created_at", "updated_at"
      ) VALUES ${Prisma.join(rows)}
      ON CONFLICT ("project_id", "source", "stable_key") DO UPDATE SET
        "task_id" = EXCLUDED."task_id",
        "target_id" = EXCLUDED."target_id",
        "artifact_id" = EXCLUDED."artifact_id",
        "kind" = EXCLUDED."kind",
        "type" = EXCLUDED."type",
        "canonical_key" = EXCLUDED."canonical_key",
        "label" = EXCLUDED."label",
        "relation" = EXCLUDED."relation",
        "from_key" = EXCLUDED."from_key",
        "to_key" = EXCLUDED."to_key",
        "from_canonical_key" = EXCLUDED."from_canonical_key",
        "to_canonical_key" = EXCLUDED."to_canonical_key",
        "attributes" = EXCLUDED."attributes",
        "is_pending" = EXCLUDED."is_pending",
        "updated_at" = CURRENT_TIMESTAMP
    `)
  }
  const parsedFindings = parseToolFindings(input.data)
  for (const finding of parsedFindings.findings) {
    const data = {
      projectId: input.projectId,
      taskId: input.taskId,
      targetId: input.targetId,
      artifactId: input.artifactId,
      title: finding.title,
      description: finding.description,
      severity: finding.severity,
      source: input.source,
      stableKey: finding.key,
      data: finding.data as unknown as Prisma.InputJsonValue,
    }
    const existing = await tx.finding.findFirst({
      where: { projectId: input.projectId, taskId: input.taskId, source: input.source, stableKey: finding.key },
      select: { id: true },
    })
    if (existing) await tx.finding.update({ where: { id: existing.id }, data })
    else await tx.finding.create({ data: { ...data, status: 'OPEN' } })
  }
  return {
    accepted: parsed.observations.length,
    rejected: parsed.rejected,
    findingsAccepted: parsedFindings.findings.length,
    findingsRejected: parsedFindings.rejected,
  }
}

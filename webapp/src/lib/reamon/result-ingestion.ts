import { Prisma } from '@prisma/client'
import type {
  ObservationAttributes,
  ObservationKind,
  ToolObservation,
} from './types'

export const MAX_OBSERVATIONS_PER_RESULT = 500
export const MAX_OBSERVATION_ATTRIBUTES = 64

const OBSERVATION_KINDS = new Set<ObservationKind>(['entity', 'relationship', 'fact'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null
}

function asAttributes(value: unknown): ObservationAttributes {
  const record = asRecord(value)
  if (!record) return {}
  const attributes: ObservationAttributes = {}
  for (const [key, rawValue] of Object.entries(record).slice(0, MAX_OBSERVATION_ATTRIBUTES)) {
    const boundedKey = boundedString(key, 128)
    if (!boundedKey) continue
    if (rawValue === null || typeof rawValue === 'string' || typeof rawValue === 'boolean') {
      attributes[boundedKey] = typeof rawValue === 'string' ? rawValue.slice(0, 4000) : rawValue
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      attributes[boundedKey] = rawValue
    }
  }
  return attributes
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
    attributes: asAttributes(record.attributes),
  }
  if (kind === 'relationship' && (!observation.fromKey || !observation.toKey)) return null
  return observation
}

export interface ParsedObservations {
  observations: ToolObservation[]
  rejected: number
}

export function parseToolObservations(data: unknown): ParsedObservations {
  const record = asRecord(data)
  const rawObservations = record?.observations
  if (!Array.isArray(rawObservations)) return { observations: [], rejected: 0 }

  const observations: ToolObservation[] = []
  const seenKeys = new Set<string>()
  let rejected = Math.max(0, rawObservations.length - MAX_OBSERVATIONS_PER_RESULT)
  for (const rawObservation of rawObservations.slice(0, MAX_OBSERVATIONS_PER_RESULT)) {
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
}

export interface ObservationIngestionSummary {
  accepted: number
  rejected: number
}

export async function ingestToolResult(
  tx: Prisma.TransactionClient,
  input: ObservationIngestionInput,
): Promise<ObservationIngestionSummary> {
  const parsed = parseToolObservations(input.data)
  for (const observation of parsed.observations) {
    const attributes = observation.attributes as unknown as Prisma.InputJsonValue
    await tx.reamonObservation.upsert({
      where: {
        projectId_source_stableKey: {
          projectId: input.projectId,
          source: input.source,
          stableKey: observation.key,
        },
      },
      create: {
        projectId: input.projectId,
        taskId: input.taskId,
        targetId: input.targetId,
        artifactId: input.artifactId,
        kind: observation.kind,
        type: observation.type,
        stableKey: observation.key,
        label: observation.label,
        source: input.source,
        relation: observation.relation,
        fromKey: observation.fromKey,
        toKey: observation.toKey,
        attributes,
      },
      update: {
        taskId: input.taskId,
        targetId: input.targetId,
        artifactId: input.artifactId,
        kind: observation.kind,
        type: observation.type,
        label: observation.label,
        relation: observation.relation,
        fromKey: observation.fromKey,
        toKey: observation.toKey,
        attributes,
      },
    })
  }
  return { accepted: parsed.observations.length, rejected: parsed.rejected }
}

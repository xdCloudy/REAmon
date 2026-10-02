import type { Session } from 'neo4j-driver'
import prisma from '@/lib/prisma'
import type { ObservationKind, ObservationValue } from './types'

const DEFAULT_BATCH_SIZE = 500
const MAX_BATCH_SIZE = 1000
export const MAX_PROJECTED_OBSERVATIONS = 10_000

export interface ProjectableObservation {
  id: string
  projectId: string
  taskId: string | null
  targetId: string | null
  artifactId: string | null
  kind: ObservationKind
  type: string
  stableKey: string
  label: string | null
  source: string
  relation: string | null
  fromKey: string | null
  toKey: string | null
  attributes: Record<string, ObservationValue>
  updatedAt: string
}

export interface ObservationProjectionResult {
  projectId: string
  selected: number
  nodes: number
  relationships: number
  truncated: boolean
}

function normaliseBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_SIZE
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(value as number)))
}

function graphProperties(observation: ProjectableObservation): Record<string, ObservationValue> {
  const properties: Record<string, ObservationValue> = {
    observation_id: observation.id,
    project_id: observation.projectId,
    source: observation.source,
    stable_key: observation.stableKey,
    kind: observation.kind,
    observation_type: observation.type,
    label: observation.label,
    task_id: observation.taskId,
    target_id: observation.targetId,
    artifact_id: observation.artifactId,
    updated_at: observation.updatedAt,
  }
  for (const [key, value] of Object.entries(observation.attributes)) {
    properties[`reamon_attr_${key}`] = value
  }
  return properties
}

function relationshipProperties(observation: ProjectableObservation): Record<string, ObservationValue> {
  const properties: Record<string, ObservationValue> = {
    project_id: observation.projectId,
    source: observation.source,
    stable_key: observation.stableKey,
    relation: observation.relation || observation.type,
    observation_id: observation.id,
    updated_at: observation.updatedAt,
  }
  for (const [key, value] of Object.entries(observation.attributes)) {
    properties[`reamon_attr_${key}`] = value
  }
  return properties
}

/**
 * Replay normalized observations into a project-scoped, fixed-label graph
 * shape. Provider-controlled types and relationship names are properties,
 * never Cypher identifiers, so arbitrary provider output cannot alter a query.
 */
export async function projectObservations(
  session: Session,
  observations: ProjectableObservation[],
  projectId: string,
  requestedBatchSize?: number,
): Promise<{ nodes: number; relationships: number }> {
  const batchSize = normaliseBatchSize(requestedBatchSize)
  const nodes = observations.filter((observation) => observation.kind !== 'relationship')
  const relationships = observations.filter((observation) => observation.kind === 'relationship')

  for (let index = 0; index < nodes.length; index += batchSize) {
    const batch = nodes.slice(index, index + batchSize).map(graphProperties)
    await session.run(
      `UNWIND $observations AS observation
       MERGE (n:ReamonObservation {
         project_id: $projectId,
         source: observation.source,
         stable_key: observation.stable_key
       })
       SET n += observation
       RETURN count(n)`,
      { projectId, observations: batch },
    )
  }

  for (let index = 0; index < relationships.length; index += batchSize) {
    const batch = relationships.slice(index, index + batchSize)
    const relationshipRows = batch.map((observation) => ({
      ...relationshipProperties(observation),
      from_key: observation.fromKey,
      to_key: observation.toKey,
    }))
    await session.run(
      `UNWIND $relationships AS relationship
       MERGE (from:ReamonObservation {
         project_id: $projectId,
         source: relationship.source,
         stable_key: relationship.from_key
       })
       ON CREATE SET from.kind = 'entity', from.observation_type = 'unknown'
       MERGE (to:ReamonObservation {
         project_id: $projectId,
         source: relationship.source,
         stable_key: relationship.to_key
       })
       ON CREATE SET to.kind = 'entity', to.observation_type = 'unknown'
       MERGE (from)-[r:REAMON_RELATIONSHIP {
         project_id: $projectId,
         source: relationship.source,
         stable_key: relationship.stable_key
       }]->(to)
       SET r += relationship
       RETURN count(r)`,
      { projectId, relationships: relationshipRows },
    )
  }

  return { nodes: nodes.length, relationships: relationships.length }
}

export async function projectReamonObservations(
  projectId: string,
  session: Session,
  requestedLimit?: number,
  requestedBatchSize?: number,
): Promise<ObservationProjectionResult> {
  const limit = Math.min(MAX_PROJECTED_OBSERVATIONS, Math.max(1, Math.floor(Number.isFinite(requestedLimit) ? requestedLimit as number : MAX_PROJECTED_OBSERVATIONS)))
  const rows = await prisma.reamonObservation.findMany({
    where: { projectId },
    orderBy: { updatedAt: 'asc' },
    take: Math.min(MAX_PROJECTED_OBSERVATIONS + 1, limit + 1),
    select: {
      id: true,
      projectId: true,
      taskId: true,
      targetId: true,
      artifactId: true,
      kind: true,
      type: true,
      stableKey: true,
      label: true,
      source: true,
      relation: true,
      fromKey: true,
      toKey: true,
      attributes: true,
      updatedAt: true,
    },
  })
  const truncated = rows.length > limit
  const observations = rows.slice(0, limit)
  const result = await projectObservations(session, observations.map((observation) => ({
    ...observation,
    kind: observation.kind as ObservationKind,
    stableKey: observation.stableKey,
    attributes: observation.attributes as ProjectableObservation['attributes'],
    updatedAt: observation.updatedAt.toISOString(),
  })), projectId, requestedBatchSize)
  return {
    projectId,
    selected: observations.length,
    ...result,
    truncated,
  }
}

import type { Session } from 'neo4j-driver'
import prisma from '@/lib/prisma'
import type { ObservationKind, ObservationValue } from './types'

const DEFAULT_BATCH_SIZE = 500
const MAX_BATCH_SIZE = 1000
export const MAX_PROJECTED_OBSERVATIONS = 10_000
export const MAX_PROJECTION_OFFSET = 1_000_000

export interface ProjectableObservation {
  id: string
  projectId: string
  taskId: string | null
  targetId: string | null
  artifactId: string | null
  kind: ObservationKind
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
  attributes: Record<string, ObservationValue>
  updatedAt: string
}

export interface ObservationProjectionResult {
  projectId: string
  offset: number
  nextOffset: number | null
  selected: number
  nodes: number
  relationships: number
  truncated: boolean
}

export interface ObservationReconciliationResult {
  deletedNodes: number
  deletedRelationships: number
}

function normaliseBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_SIZE
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(value as number)))
}

function normaliseOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(MAX_PROJECTION_OFFSET, Math.max(0, Math.floor(value as number)))
}

function graphProperties(observation: ProjectableObservation, projectionRunId?: string): Record<string, ObservationValue> {
  const properties: Record<string, ObservationValue> = {
    observation_id: observation.id,
    project_id: observation.projectId,
    source: observation.source,
    stable_key: observation.stableKey,
    canonical_key: observation.canonicalKey,
    kind: observation.kind,
    observation_type: observation.type,
    label: observation.label,
    task_id: observation.taskId,
    target_id: observation.targetId,
    artifact_id: observation.artifactId,
    updated_at: observation.updatedAt,
    reamon_projection_run_id: projectionRunId || null,
  }
  for (const [key, value] of Object.entries(observation.attributes)) {
    properties[`reamon_attr_${key}`] = value
  }
  return properties
}

function relationshipProperties(observation: ProjectableObservation, projectionRunId?: string): Record<string, ObservationValue> {
  const properties: Record<string, ObservationValue> = {
    project_id: observation.projectId,
    source: observation.source,
    stable_key: observation.stableKey,
    canonical_key: observation.canonicalKey,
    relation: observation.relation || observation.type,
    observation_id: observation.id,
    updated_at: observation.updatedAt,
    from_canonical_key: observation.fromCanonicalKey,
    to_canonical_key: observation.toCanonicalKey,
    reamon_projection_run_id: projectionRunId || null,
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
  projectionRunId?: string,
): Promise<{ nodes: number; relationships: number }> {
  const batchSize = normaliseBatchSize(requestedBatchSize)
  const nodes = observations.filter((observation) => observation.kind !== 'relationship')
  const relationships = observations.filter((observation) => observation.kind === 'relationship')
  const canonicalByReference = new Map(
    observations.map((observation) => [`${observation.source}:${observation.stableKey}`, observation.canonicalKey]),
  )

  for (let index = 0; index < nodes.length; index += batchSize) {
    const batch = nodes.slice(index, index + batchSize).map((observation) => graphProperties(observation, projectionRunId))
    await session.run(
      `UNWIND $observations AS observation
       MERGE (n:ReamonObservation {
         project_id: $projectId,
         canonical_key: observation.canonical_key
       })
       SET n += observation
       RETURN count(n)`,
      { projectId, observations: batch },
    )
  }

  for (let index = 0; index < relationships.length; index += batchSize) {
    const batch = relationships.slice(index, index + batchSize)
    const relationshipRows = batch.map((observation) => ({
      ...relationshipProperties(observation, projectionRunId),
      from_key: observation.fromCanonicalKey || canonicalByReference.get(`${observation.source}:${observation.fromKey}`) || `source:${observation.source}:${observation.fromKey}`,
      to_key: observation.toCanonicalKey || canonicalByReference.get(`${observation.source}:${observation.toKey}`) || `source:${observation.source}:${observation.toKey}`,
      from_stable_key: observation.fromKey,
      to_stable_key: observation.toKey,
    }))
    await session.run(
      `UNWIND $relationships AS relationship
       MERGE (from:ReamonObservation {
         project_id: $projectId,
         canonical_key: relationship.from_key
       })
       ON CREATE SET from.kind = 'entity', from.observation_type = 'unknown', from.source = relationship.source, from.stable_key = relationship.from_stable_key
       SET from.reamon_projection_run_id = $projectionRunId
       MERGE (to:ReamonObservation {
         project_id: $projectId,
         canonical_key: relationship.to_key
       })
       ON CREATE SET to.kind = 'entity', to.observation_type = 'unknown', to.source = relationship.source, to.stable_key = relationship.to_stable_key
       SET to.reamon_projection_run_id = $projectionRunId
       MERGE (from)-[r:REAMON_RELATIONSHIP {
         project_id: $projectId,
         canonical_key: relationship.canonical_key
       }]->(to)
       SET r += relationship
       RETURN count(r)`,
      { projectId, projectionRunId: projectionRunId || null, relationships: relationshipRows },
    )
  }

  return { nodes: nodes.length, relationships: relationships.length }
}

export async function projectReamonObservations(
  projectId: string,
  session: Session,
  requestedLimit?: number,
  requestedBatchSize?: number,
  requestedOffset?: number,
  projectionRunId?: string,
): Promise<ObservationProjectionResult> {
  const limit = Math.min(MAX_PROJECTED_OBSERVATIONS, Math.max(1, Math.floor(Number.isFinite(requestedLimit) ? requestedLimit as number : MAX_PROJECTED_OBSERVATIONS)))
  const offset = normaliseOffset(requestedOffset)
  const rows = await prisma.reamonObservation.findMany({
    where: { projectId },
    orderBy: { updatedAt: 'asc' },
    skip: offset,
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
      canonicalKey: true,
      label: true,
      source: true,
      relation: true,
      fromKey: true,
      toKey: true,
      fromCanonicalKey: true,
      toCanonicalKey: true,
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
    canonicalKey: observation.canonicalKey,
    fromCanonicalKey: observation.fromCanonicalKey,
    toCanonicalKey: observation.toCanonicalKey,
    attributes: observation.attributes as ProjectableObservation['attributes'],
    updatedAt: observation.updatedAt.toISOString(),
  })), projectId, requestedBatchSize, projectionRunId)
  return {
    projectId,
    offset,
    nextOffset: truncated ? offset + observations.length : null,
    selected: observations.length,
    ...result,
    truncated,
  }
}

/**
 * Remove graph records from an explicitly completed projection run that are no
 * longer present in the relational observation source. The run marker is
 * written on every page, so this remains bounded in memory and safe for large
 * projects. The caller must hold the project projection lease.
 */
export async function reconcileProjectedGraph(
  session: Session,
  projectId: string,
  projectionRunId: string,
): Promise<ObservationReconciliationResult> {
  const relationshipResult = await session.run(
    `MATCH ()-[relationship:REAMON_RELATIONSHIP {project_id: $projectId}]->()
     WHERE coalesce(relationship.reamon_projection_run_id, '') <> $projectionRunId
     DELETE relationship
     RETURN count(*) AS deleted`,
    { projectId, projectionRunId },
  )
  const nodeResult = await session.run(
    `MATCH (node:ReamonObservation {project_id: $projectId})
     WHERE coalesce(node.reamon_projection_run_id, '') <> $projectionRunId
     DETACH DELETE node
     RETURN count(*) AS deleted`,
    { projectId, projectionRunId },
  )
  const value = (result: { records?: Array<{ get: (key: string) => unknown }> }) => {
    const raw = result.records?.[0]?.get('deleted')
    return typeof raw === 'object' && raw !== null && 'toNumber' in raw && typeof raw.toNumber === 'function'
      ? raw.toNumber()
      : Number(raw || 0)
  }
  return { deletedRelationships: value(relationshipResult), deletedNodes: value(nodeResult) }
}

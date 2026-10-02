import type { CapabilityMatch, TargetProfile } from './types'
import type { WorkspaceFileQuery, WorkspaceFileQueryResult } from './inventory-query'

/**
 * A proposal is deliberately not a task or an execution request. It is the
 * deterministic hand-off between inventory and a future scheduler: an agent
 * can inspect what would be compatible without causing a heavyweight tool to
 * run against every matching file.
 */
export interface WorkspaceAnalysisPlanQuery extends WorkspaceFileQuery {
  capability?: string
}

export interface WorkspaceAnalysisPlanStep {
  id: string
  status: 'PROPOSED'
  artifactId: string
  relativePath: string
  profile: TargetProfile
  capability: string
  provider: CapabilityMatch
  reason: string
}

export interface WorkspaceAnalysisPlan {
  projectId: string
  source: 'ACTIVE_WORKSPACE_INVENTORY'
  requestedCapability: string | null
  query: WorkspaceAnalysisPlanQuery
  candidateArtifacts: number
  returnedArtifacts: number
  proposedSteps: number
  steps: WorkspaceAnalysisPlanStep[]
  hasMoreArtifacts: boolean
  hasMoreSteps: boolean
}

const MAX_PROPOSED_STEPS = 500

function normaliseCapability(value: string | undefined): string | undefined {
  const normalised = value?.trim().toLowerCase()
  return normalised || undefined
}

function stepId(artifactId: string, providerId: string, capability: string): string {
  return `${artifactId}:${providerId}:${capability}`
}

export function buildWorkspaceAnalysisPlan(
  projectId: string,
  inventory: WorkspaceFileQueryResult,
  query: WorkspaceAnalysisPlanQuery = {},
): WorkspaceAnalysisPlan {
  const requestedCapability = normaliseCapability(query.capability)
  const steps: WorkspaceAnalysisPlanStep[] = []

  for (const artifact of inventory.artifacts) {
    const profile = artifact.profile as TargetProfile
    for (const provider of artifact.capabilities) {
      for (const capability of provider.capabilities) {
        if (requestedCapability && capability.toLowerCase() !== requestedCapability) continue
        steps.push({
          id: stepId(artifact.id, provider.pluginId, capability),
          status: 'PROPOSED',
          artifactId: artifact.id,
          relativePath: artifact.relativePath,
          profile,
          capability,
          provider,
          reason: `${provider.pluginName} advertises ${capability} for the stored ${profile.format || 'unknown'} profile.`,
        })
      }
    }
  }

  const hasMoreSteps = steps.length > MAX_PROPOSED_STEPS || inventory.hasMore
  return {
    projectId,
    source: 'ACTIVE_WORKSPACE_INVENTORY',
    requestedCapability: requestedCapability ?? null,
    query: {
      ...(query.search ? { search: query.search } : {}),
      ...(query.format ? { format: query.format } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.capability ? { capability: query.capability } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    },
    candidateArtifacts: inventory.total,
    returnedArtifacts: inventory.artifacts.length,
    proposedSteps: Math.min(steps.length, MAX_PROPOSED_STEPS),
    steps: steps.slice(0, MAX_PROPOSED_STEPS),
    hasMoreArtifacts: inventory.hasMore,
    hasMoreSteps,
  }
}


import { createHash } from 'node:crypto'
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
  stepLimit?: number
  stepOffset?: number
  snapshotId?: string
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
  previousRunCount?: number
  latestTask?: {
    id: string
    status: string
    progress: number
    progressMessage: string
    error: string
    leaseHeartbeatAt: string | null
    updatedAt: string
  } | null
}

export interface WorkspaceAnalysisPlan {
  projectId: string
  source: 'ACTIVE_WORKSPACE_INVENTORY'
  requestedCapability: string | null
  query: WorkspaceAnalysisPlanQuery
  candidateArtifacts: number
  returnedArtifacts: number
  proposedSteps: number
  totalCandidateSteps: number
  stepLimit: number
  stepOffset: number
  snapshotId: string
  nextStepOffset: number | null
  steps: WorkspaceAnalysisPlanStep[]
  hasMoreArtifacts: boolean
  hasMoreSteps: boolean
  clearedProposalIds?: string[]
  lastProjectScan?: {
    scannedAt: string
    artifactsScanned: number
    proposalCount: number
    previousTasks: number
    findings: number
    hypotheses: number
    evidence: number
  } | null
}

export const MAX_ANALYSIS_PLAN_STEP_PAGE_SIZE = 500

function normaliseCapability(value: string | undefined): string | undefined {
  const normalised = value?.trim().toLowerCase()
  return normalised || undefined
}

function stepId(artifactId: string, providerId: string, capability: string): string {
  return `${artifactId}:${providerId}:${capability}`
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([key, nested]) => [key, canonicalValue(nested)]))
  }
  return value
}

function snapshotFor(
  projectId: string,
  inventory: WorkspaceFileQueryResult,
  query: WorkspaceAnalysisPlanQuery,
  capability: string | undefined,
  stepLimit: number,
): string {
  const artifacts = inventory.artifacts.map((artifact) => ({
      id: artifact.id,
      relativePath: artifact.relativePath,
      sha256: artifact.sha256,
      profile: artifact.profile,
      capabilities: artifact.capabilities,
    }))
  const value = canonicalValue({
    schemaVersion: 1,
    projectId,
    filters: {
      search: query.search?.trim().slice(0, 200) || undefined,
      format: query.format?.trim().toLowerCase().slice(0, 64) || undefined,
      kind: query.kind,
      capability,
      limit: inventory.limit,
      offset: inventory.offset,
      stepLimit,
    },
    totalArtifacts: inventory.total,
    hasMoreArtifacts: inventory.hasMore,
    artifacts,
  })
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function buildWorkspaceAnalysisPlan(
  projectId: string,
  inventory: WorkspaceFileQueryResult,
  query: WorkspaceAnalysisPlanQuery = {},
): WorkspaceAnalysisPlan {
  const requestedCapability = normaliseCapability(query.capability)
  const stepLimit = Math.max(1, Math.min(Math.floor(query.stepLimit ?? MAX_ANALYSIS_PLAN_STEP_PAGE_SIZE), MAX_ANALYSIS_PLAN_STEP_PAGE_SIZE))
  const stepOffset = Math.max(0, Math.min(Math.floor(query.stepOffset ?? 0), 100000))
  const snapshotId = snapshotFor(projectId, inventory, query, requestedCapability, stepLimit)
  const steps: WorkspaceAnalysisPlanStep[] = []
  let totalCandidateSteps = 0

  for (const artifact of inventory.artifacts) {
    const profile = artifact.profile as TargetProfile
    for (const provider of artifact.capabilities) {
      for (const capability of provider.capabilities) {
        if (requestedCapability && capability.toLowerCase() !== requestedCapability) continue
        const candidateIndex = totalCandidateSteps++
        if (candidateIndex < stepOffset || candidateIndex >= stepOffset + stepLimit) continue
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

  const hasMoreSteps = stepOffset + steps.length < totalCandidateSteps
  const nextStepOffset = hasMoreSteps ? stepOffset + steps.length : null
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
      ...(query.stepLimit !== undefined ? { stepLimit: query.stepLimit } : {}),
      ...(query.stepOffset !== undefined ? { stepOffset: query.stepOffset } : {}),
    },
    candidateArtifacts: inventory.total,
    returnedArtifacts: inventory.artifacts.length,
    proposedSteps: steps.length,
    totalCandidateSteps,
    stepLimit,
    stepOffset,
    snapshotId,
    nextStepOffset,
    steps,
    hasMoreArtifacts: inventory.hasMore,
    hasMoreSteps,
  }
}


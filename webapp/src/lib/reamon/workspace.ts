import prisma from '@/lib/prisma'
import { resolveCapabilities, resolveWorkspaceCapabilities } from './capabilities'
import { buildProgressModel } from './progress'
import { getActiveWorkspaceImportSelection } from './inventory-query'
import { activeWorkspaceTargetIds } from './imports'
import { listWorkerHealth } from './worker-health'
import type { TargetProfile, WorkspaceImportSnapshot, WorkspaceObservation } from './types'
import type { WorkspaceImportComparison } from './imports'
import { buildLegacyCompatibilityReport } from './legacy-compat'

export const WORKSPACE_ARTIFACT_PREVIEW_LIMIT = 500

function asProfile(value: unknown): TargetProfile {
  return value as TargetProfile
}

export async function getWorkspaceSnapshot(projectId: string) {
  const projectPromise = prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, description: true, projectKind: true, createdAt: true, updatedAt: true },
  })
  const importsPromise = prisma.workspaceImport.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      rootTarget: { select: { profile: true } },
      artifacts: { select: { relativePath: true } },
    },
  })
  const selectionPromise = getActiveWorkspaceImportSelection(projectId)
  const workersPromise = listWorkerHealth()
  const [project, imports, selection, workers] = await Promise.all([projectPromise, importsPromise, selectionPromise, workersPromise])
  if (!project) return null

  const [
    allTargets,
    artifacts,
    artifactMetadata,
    artifactCount,
    tasks,
    findings,
    hypotheses,
    evidence,
    observations,
    projectionRuns,
    activities,
    taskStatuses,
    findingStatuses,
    hypothesisStatuses,
    taskCount,
    findingCount,
    hypothesisCount,
    evidenceCount,
    observationCount,
    approvalStatuses,
  ] = await Promise.all([
    prisma.target.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
    prisma.artifact.findMany({
      where: selection.artifactWhere,
      orderBy: [{ relativePath: 'asc' }, { id: 'asc' }],
      take: WORKSPACE_ARTIFACT_PREVIEW_LIMIT,
    }),
    prisma.artifact.findMany({ where: selection.artifactWhere, select: { id: true, targetId: true, status: true, profile: true } }),
    prisma.artifact.count({ where: selection.artifactWhere }),
    prisma.task.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true,
        projectId: true,
        targetId: true,
        artifactId: true,
        providerId: true,
        capability: true,
        title: true,
        category: true,
        status: true,
        progress: true,
        options: true,
        result: true,
        error: true,
        startedAt: true,
        leaseHeartbeatAt: true,
        leaseOwner: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        approval: {
          select: {
            id: true,
            status: true,
            requestedBy: true,
            decidedBy: true,
            reason: true,
            requestedAt: true,
            decidedAt: true,
          },
        },
      },
    }),
    prisma.finding.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.hypothesis.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.evidence.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.reamonObservation.findMany({ where: { projectId }, orderBy: { updatedAt: 'desc' }, take: 40 }),
    prisma.reamonProjectionRun.findMany({
      where: { projectId },
      orderBy: { startedAt: 'desc' },
      take: 10,
      select: {
        projectionRunId: true,
        status: true,
        offset: true,
        selected: true,
        nodes: true,
        relationships: true,
        truncated: true,
        reconciled: true,
        deletedNodes: true,
        deletedRelationships: true,
        error: true,
        startedAt: true,
        completedAt: true,
      },
    }),
    prisma.workspaceActivity.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.task.findMany({ where: { projectId }, select: { status: true } }),
    prisma.finding.findMany({ where: { projectId }, select: { status: true } }),
    prisma.hypothesis.findMany({ where: { projectId }, select: { status: true } }),
    prisma.task.count({ where: { projectId } }),
    prisma.finding.count({ where: { projectId } }),
    prisma.hypothesis.count({ where: { projectId } }),
    prisma.evidence.count({ where: { projectId } }),
    prisma.reamonObservation.count({ where: { projectId } }),
    prisma.reamonApproval.findMany({ where: { projectId }, select: { status: true } }),
  ])

  const approvalSummary = approvalStatuses.reduce((summary, approval) => {
    if (approval.status === 'PENDING') summary.pending += 1
    else if (approval.status === 'APPROVED') summary.approved += 1
    else if (approval.status === 'REJECTED') summary.rejected += 1
    return summary
  }, { pending: 0, approved: 0, rejected: 0 })

  const activeArtifactTargetIds = new Set(artifactMetadata
    .map((artifact) => artifact.targetId)
    .filter((targetId): targetId is string => Boolean(targetId)))
  const visibleTargetIds = activeWorkspaceTargetIds(
    allTargets,
    selection.activeRootTargetIds,
    activeArtifactTargetIds,
    selection.states.length > 0,
  )
  const targets = allTargets.filter((target) => visibleTargetIds.has(target.id))

  const serializedArtifacts = artifacts.map((artifact) => {
    const profile = asProfile(artifact.profile)
    return {
      id: artifact.id,
      name: artifact.name,
      originalName: artifact.originalName,
      targetId: artifact.targetId,
      importId: artifact.importId,
      relativePath: artifact.relativePath || artifact.originalName,
      parentPath: artifact.parentPath,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      mimeType: artifact.mimeType,
      extension: artifact.extension,
      status: artifact.status,
      profile,
      capabilities: resolveCapabilities(profile),
      createdAt: artifact.createdAt.toISOString(),
      updatedAt: artifact.updatedAt.toISOString(),
    }
  })

  const progress = buildProgressModel({
    taskStatuses: taskStatuses.map((task) => task.status as never),
    findingStatuses: findingStatuses.map((finding) => finding.status as never),
    hypothesisStatuses: hypothesisStatuses.map((hypothesis) => hypothesis.status as never),
  })

  return {
    workspace: {
      ...project,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    },
    compatibility: buildLegacyCompatibilityReport(project.projectKind),
    targets: targets.map((target) => ({
      ...target,
      targetType: target.targetType,
      status: target.status,
      parentTargetId: target.parentTargetId,
      profile: asProfile(target.profile),
      createdAt: target.createdAt.toISOString(),
      updatedAt: target.updatedAt.toISOString(),
    })),
    artifacts: serializedArtifacts,
    tasks,
    findings,
    hypotheses,
    evidence,
    observations: observations.map((observation): WorkspaceObservation => ({
      id: observation.id,
      projectId: observation.projectId,
      taskId: observation.taskId,
      targetId: observation.targetId,
      artifactId: observation.artifactId,
      kind: observation.kind as WorkspaceObservation['kind'],
      type: observation.type,
      key: observation.stableKey,
      label: observation.label || undefined,
      source: observation.source,
      relation: observation.relation || undefined,
      fromKey: observation.fromKey || undefined,
      toKey: observation.toKey || undefined,
      fromCanonicalKey: observation.fromCanonicalKey || undefined,
      toCanonicalKey: observation.toCanonicalKey || undefined,
      attributes: observation.attributes as WorkspaceObservation['attributes'],
      createdAt: observation.createdAt.toISOString(),
      updatedAt: observation.updatedAt.toISOString(),
    })),
    projectionRuns: projectionRuns.map((run) => ({
      projectionRunId: run.projectionRunId,
      status: run.status,
      offset: run.offset,
      selected: run.selected,
      nodes: run.nodes,
      relationships: run.relationships,
      truncated: run.truncated,
      reconciled: run.reconciled,
      deletedNodes: run.deletedNodes,
      deletedRelationships: run.deletedRelationships,
      error: run.error,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() || null,
    })),
    activities,
    workers,
    capabilities: resolveWorkspaceCapabilities(artifactMetadata.map((artifact) => ({ id: artifact.id, profile: asProfile(artifact.profile) }))),
    imports: imports.map((workspaceImport): WorkspaceImportSnapshot => {
      const manifest = Array.isArray(workspaceImport.manifest)
        ? workspaceImport.manifest as Array<{ relativePath?: unknown }>
        : []
      const uploaded = new Set(workspaceImport.artifacts.map((artifact) => artifact.relativePath))
      return {
        id: workspaceImport.id,
        sourceType: workspaceImport.sourceType,
        rootName: workspaceImport.rootName,
        status: workspaceImport.status,
        totalFiles: workspaceImport.totalFiles,
        completedFiles: workspaceImport.completedFiles,
        failedFiles: workspaceImport.failedFiles,
        totalBytes: Number(workspaceImport.totalBytes),
        uploadedBytes: Number(workspaceImport.uploadedBytes),
        errorSummary: workspaceImport.errorSummary,
        completedAt: workspaceImport.completedAt?.toISOString() || null,
        rootTargetId: workspaceImport.rootTargetId,
        missingPaths: manifest
          .map((entry) => typeof entry.relativePath === 'string' ? entry.relativePath : '')
          .filter((relativePath) => relativePath && !uploaded.has(relativePath))
          .slice(0, 200),
        profile: workspaceImport.rootTarget?.profile as WorkspaceImportSnapshot['profile'],
        comparison: workspaceImport.metadata && typeof workspaceImport.metadata === 'object' && !Array.isArray(workspaceImport.metadata)
          ? (workspaceImport.metadata as { comparison?: WorkspaceImportComparison }).comparison || null
          : null,
      }
    }),
    progress,
    artifactPage: {
      limit: WORKSPACE_ARTIFACT_PREVIEW_LIMIT,
      total: artifactCount,
      hasMore: artifactCount > serializedArtifacts.length,
    },
    counts: {
      targets: targets.length,
      artifacts: artifactCount,
      tasks: taskCount,
      findings: findingCount,
      hypotheses: hypothesisCount,
      evidence: evidenceCount,
      observations: observationCount,
    },
    approvalSummary: {
      ...approvalSummary,
      total: approvalStatuses.length,
    },
  }
}

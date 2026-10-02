import prisma from '@/lib/prisma'
import { resolveCapabilities, resolveWorkspaceCapabilities } from './capabilities'
import { buildProgressModel } from './progress'
import { getActiveWorkspaceImportSelection } from './inventory-query'
import { activeWorkspaceTargetIds } from './imports'
import type { TargetProfile, WorkspaceImportSnapshot } from './types'
import type { WorkspaceImportComparison } from './imports'

function asProfile(value: unknown): TargetProfile {
  return value as TargetProfile
}

export async function getWorkspaceSnapshot(projectId: string) {
  const projectPromise = prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, description: true, createdAt: true, updatedAt: true },
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
  const [project, imports, selection] = await Promise.all([projectPromise, importsPromise, selectionPromise])
  if (!project) return null

  const [
    allTargets,
    artifacts,
    tasks,
    findings,
    hypotheses,
    evidence,
    activities,
    taskStatuses,
    findingStatuses,
    hypothesisStatuses,
    taskCount,
    findingCount,
    hypothesisCount,
    evidenceCount,
  ] = await Promise.all([
    prisma.target.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
    prisma.artifact.findMany({ where: selection.artifactWhere, orderBy: { createdAt: 'desc' } }),
    prisma.task.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.finding.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.hypothesis.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.evidence.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.workspaceActivity.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.task.findMany({ where: { projectId }, select: { status: true } }),
    prisma.finding.findMany({ where: { projectId }, select: { status: true } }),
    prisma.hypothesis.findMany({ where: { projectId }, select: { status: true } }),
    prisma.task.count({ where: { projectId } }),
    prisma.finding.count({ where: { projectId } }),
    prisma.hypothesis.count({ where: { projectId } }),
    prisma.evidence.count({ where: { projectId } }),
  ])

  const activeArtifactTargetIds = new Set(artifacts
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
    targetStatuses: targets.map((target) => target.status as never),
    artifactStatuses: artifacts.map((artifact) => artifact.status as never),
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
    activities,
    capabilities: resolveWorkspaceCapabilities(serializedArtifacts.map((artifact) => ({ id: artifact.id, profile: artifact.profile }))),
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
    counts: {
      targets: targets.length,
      artifacts: artifacts.length,
      tasks: taskCount,
      findings: findingCount,
      hypotheses: hypothesisCount,
      evidence: evidenceCount,
    },
  }
}

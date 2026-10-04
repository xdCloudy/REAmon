import prisma from '@/lib/prisma'
import { resolveWorkspaceCapabilities } from './capabilities'
import { getActiveWorkspaceImportSelection } from './inventory-query'
import { activeWorkspaceTargetIds } from './imports'
import { buildProgressModel } from './progress'
import type { TargetProfile, ProgressModel } from './types'

const MAX_DIMENSION_VALUES = 25
const MAX_SAMPLE_TARGETS = 100

interface CountedValue {
  value: string
  count: number
}

type ProfileLike = Partial<TargetProfile> & { directoryCount?: unknown }

export interface WorkspaceInventorySummary {
  projectId: string
  workspace: {
    id: string
    name: string
    description: string | null
    projectKind: string
    updatedAt: string
  }
  roots: Array<{
    importId: string
    rootTargetId: string | null
    rootName: string
    sourceType: string
    status: string
    totalFiles: number
    completedFiles: number
    failedFiles: number
    totalBytes: number
    uploadedBytes: number
    profile: unknown
  }>
  rootCount: number
  counts: {
    files: number
    directories: number
    totalBytes: number
    targets: number
    tasks: number
    findings: number
    hypotheses: number
    evidence: number
  }
  profiles: {
    formats: CountedValue[]
    platforms: CountedValue[]
    architectures: CountedValue[]
    runtimes: CountedValue[]
  }
  logicalTargets: Array<{
    id: string
    name: string
    targetType: string
    parentTargetId: string | null
    status: string
  }>
  logicalTargetsTruncated: boolean
  capabilities: Array<{
    pluginId: string
    pluginName: string
    category: string
    integration: string
    acceptsTargetTypes: string[]
    acceptsFormats: string[]
    capabilities: string[]
    produces: string[]
    requirements: Array<{ key: string; value?: string | number | boolean; optional?: boolean }>
    compatibleArtifactCount: number
  }>
  progress: ProgressModel
}

function profileOf(value: unknown): ProfileLike {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ProfileLike
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null
}

function counted(values: Array<string | null>): CountedValue[] {
  const counts = new Map<string, number>()
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, MAX_DIMENSION_VALUES)
}

function arrayValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase())
    : []
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export async function getWorkspaceInventorySummary(projectId: string): Promise<WorkspaceInventorySummary | null> {
  const [project, selection] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, description: true, projectKind: true, updatedAt: true },
    }),
    getActiveWorkspaceImportSelection(projectId),
  ])
  if (!project) return null

  const [imports, allTargets, artifacts, tasks, findings, hypotheses, evidenceCount] = await Promise.all([
    prisma.workspaceImport.findMany({
      where: { id: { in: [...selection.activeImportIds] } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        rootTargetId: true,
        sourceType: true,
        rootName: true,
        status: true,
        totalFiles: true,
        completedFiles: true,
        failedFiles: true,
        totalBytes: true,
        uploadedBytes: true,
        rootTarget: { select: { profile: true } },
      },
    }),
    prisma.target.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, targetType: true, parentTargetId: true, status: true, profile: true },
    }),
    prisma.artifact.findMany({
      where: selection.artifactWhere,
      orderBy: [{ relativePath: 'asc' }, { id: 'asc' }],
      select: { id: true, targetId: true, sizeBytes: true, status: true, profile: true },
    }),
    prisma.task.findMany({ where: { projectId }, select: { status: true } }),
    prisma.finding.findMany({ where: { projectId }, select: { status: true } }),
    prisma.hypothesis.findMany({ where: { projectId }, select: { status: true } }),
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
  const visibleTargets = allTargets.filter((target) => visibleTargetIds.has(target.id))
  const rootProfiles = imports.map((workspaceImport) => profileOf(workspaceImport.rootTarget?.profile))
  const profiles = artifacts.map((artifact) => profileOf(artifact.profile))
  const capabilities = resolveWorkspaceCapabilities(artifacts.map((artifact) => ({
    id: artifact.id,
    profile: artifact.profile as unknown as TargetProfile,
  }))).map((provider) => ({
    pluginId: provider.pluginId,
    pluginName: provider.pluginName,
    category: provider.category,
    integration: provider.integration,
    acceptsTargetTypes: provider.acceptsTargetTypes,
    acceptsFormats: provider.acceptsFormats,
    capabilities: provider.capabilities,
    produces: provider.produces,
    requirements: provider.requirements,
    compatibleArtifactCount: provider.compatibleArtifactIds.length,
  }))

  return {
    projectId,
    workspace: {
      id: project.id,
      name: project.name,
      description: project.description,
      projectKind: project.projectKind,
      updatedAt: project.updatedAt.toISOString(),
    },
    roots: imports.map((workspaceImport) => ({
      importId: workspaceImport.id,
      rootTargetId: workspaceImport.rootTargetId,
      rootName: workspaceImport.rootName,
      sourceType: workspaceImport.sourceType,
      status: workspaceImport.status,
      totalFiles: workspaceImport.totalFiles,
      completedFiles: workspaceImport.completedFiles,
      failedFiles: workspaceImport.failedFiles,
      totalBytes: Number(workspaceImport.totalBytes),
      uploadedBytes: Number(workspaceImport.uploadedBytes),
      profile: workspaceImport.rootTarget?.profile || null,
    })),
    rootCount: imports.length,
    counts: {
      files: artifacts.length,
      directories: rootProfiles.reduce((sum, profile) => sum + nonNegativeNumber(profile.directoryCount), 0),
      totalBytes: artifacts.reduce((sum, artifact) => sum + nonNegativeNumber(artifact.sizeBytes), 0),
      targets: visibleTargets.length,
      tasks: tasks.length,
      findings: findings.length,
      hypotheses: hypotheses.length,
      evidence: evidenceCount,
    },
    profiles: {
      formats: counted(profiles.map((profile) => stringValue(profile.format))),
      platforms: counted(profiles.map((profile) => stringValue(profile.platform))),
      architectures: counted(profiles.map((profile) => stringValue(profile.architecture))),
      runtimes: counted(profiles.flatMap((profile) => arrayValues(profile.runtimes))),
    },
    logicalTargets: visibleTargets.slice(0, MAX_SAMPLE_TARGETS).map((target) => ({
      id: target.id,
      name: target.name,
      targetType: target.targetType,
      parentTargetId: target.parentTargetId,
      status: target.status,
    })),
    logicalTargetsTruncated: visibleTargets.length > MAX_SAMPLE_TARGETS,
    capabilities,
    progress: buildProgressModel({
      taskStatuses: tasks.map((task) => task.status as never),
      findingStatuses: findings.map((finding) => finding.status as never),
      hypothesisStatuses: hypotheses.map((hypothesis) => hypothesis.status as never),
    }),
  }
}

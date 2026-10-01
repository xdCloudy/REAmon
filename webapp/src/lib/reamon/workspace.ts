import prisma from '@/lib/prisma'
import { resolveCapabilities } from './capabilities'
import { buildProgressModel } from './progress'
import type { TargetProfile } from './types'

function asProfile(value: unknown): TargetProfile {
  return value as TargetProfile
}

export async function getWorkspaceSnapshot(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, description: true, createdAt: true, updatedAt: true },
  })
  if (!project) return null

  const [targets, artifacts, tasks, findings, hypotheses, evidence, activities] = await Promise.all([
    prisma.target.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
    prisma.artifact.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
    prisma.task.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.finding.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.hypothesis.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.evidence.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.workspaceActivity.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ])

  const serializedArtifacts = artifacts.map((artifact) => {
    const profile = asProfile(artifact.profile)
    return {
      id: artifact.id,
      name: artifact.name,
      originalName: artifact.originalName,
      targetId: artifact.targetId,
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
    taskStatuses: tasks.map((task) => task.status as never),
    findingStatuses: findings.map((finding) => finding.status as never),
    hypothesisStatuses: hypotheses.map((hypothesis) => hypothesis.status as never),
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
    progress,
    counts: {
      targets: targets.length,
      artifacts: artifacts.length,
      tasks: await prisma.task.count({ where: { projectId } }),
      findings: await prisma.finding.count({ where: { projectId } }),
      hypotheses: await prisma.hypothesis.count({ where: { projectId } }),
      evidence: await prisma.evidence.count({ where: { projectId } }),
    },
  }
}

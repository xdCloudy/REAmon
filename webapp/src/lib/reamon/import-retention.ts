import { unlink } from 'node:fs/promises'
import prisma from '@/lib/prisma'
import { resolveArtifactStoragePath } from './artifact-storage'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETENTION_DAYS = 90
const MIN_RETENTION_DAYS = 7
const MAX_RETENTION_DAYS = 3650
const MAX_IMPORTS_PER_RUN = 25

export function importRetentionDays(): number {
  const raw = Number(process.env.REAMON_IMPORT_RETENTION_DAYS)
  if (!Number.isFinite(raw)) return DEFAULT_RETENTION_DAYS
  if (raw <= 0) return 0
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.floor(raw)))
}

interface RetentionArtifact {
  id: string
  storagePath: string
  sizeBytes: number
  _count: {
    tasks: number
    findings: number
    evidence: number
    observations: number
    usedAsSource: number
    derivedFrom: number
  }
}

interface RetentionCandidate {
  id: string
  projectId: string
  rootTargetId: string | null
  completedAt: Date
  artifacts: RetentionArtifact[]
}

export interface ImportRetentionCandidate {
  id: string
  projectId: string
  completedAt: string
  artifactCount: number
  bytes: number
  protectedByReferences: boolean
}

export interface ImportRetentionResult {
  dryRun: boolean
  retentionDays: number
  cutoff: string | null
  considered: number
  protected: number
  pruned: number
  deletedArtifacts: number
  deletedBytes: number
  storageCleanupFailures: number
  candidates: ImportRetentionCandidate[]
}

const artifactSelect = {
  id: true,
  storagePath: true,
  sizeBytes: true,
  _count: { select: { tasks: true, findings: true, evidence: true, observations: true, usedAsSource: true, derivedFrom: true } },
} as const

async function findCandidates(projectId: string | undefined, cutoff: Date): Promise<RetentionCandidate[]> {
  const latest = await prisma.workspaceImport.findMany({
    where: { ...(projectId ? { projectId } : {}), status: 'COMPLETED' },
    orderBy: [{ projectId: 'asc' }, { completedAt: 'desc' }],
    distinct: ['projectId'],
    select: { id: true },
  })
  const latestIds = latest.map((value) => value.id)
  return prisma.workspaceImport.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      status: 'COMPLETED',
      completedAt: { not: null, lt: cutoff },
      ...(latestIds.length ? { id: { notIn: latestIds } } : {}),
    },
    orderBy: { completedAt: 'asc' },
    take: MAX_IMPORTS_PER_RUN,
    select: {
      id: true,
      projectId: true,
      rootTargetId: true,
      completedAt: true,
      artifacts: { select: artifactSelect },
    },
  }) as unknown as Promise<RetentionCandidate[]>
}

function candidateSummary(candidate: RetentionCandidate, protectedByReferences: boolean): ImportRetentionCandidate {
  return {
    id: candidate.id,
    projectId: candidate.projectId,
    completedAt: candidate.completedAt.toISOString(),
    artifactCount: candidate.artifacts.length,
    bytes: candidate.artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0),
    protectedByReferences,
  }
}

function hasReferences(candidate: RetentionCandidate): boolean {
  return candidate.artifacts.some((artifact) => Object.values(artifact._count).some((count) => count > 0))
}

export async function applyImportRetention(input: { projectId?: string; dryRun?: boolean; now?: Date } = {}): Promise<ImportRetentionResult> {
  const retentionDays = importRetentionDays()
  if (retentionDays === 0) {
    return { dryRun: input.dryRun !== false, retentionDays, cutoff: null, considered: 0, protected: 0, pruned: 0, deletedArtifacts: 0, deletedBytes: 0, storageCleanupFailures: 0, candidates: [] }
  }

  const cutoff = new Date((input.now || new Date()).getTime() - retentionDays * DAY_MS)
  const candidates = await findCandidates(input.projectId, cutoff)
  const summaries = candidates.map((candidate) => candidateSummary(candidate, hasReferences(candidate)))
  const protectedCount = summaries.filter((candidate) => candidate.protectedByReferences).length
  if (input.dryRun !== false) {
    return {
      dryRun: true,
      retentionDays,
      cutoff: cutoff.toISOString(),
      considered: candidates.length,
      protected: protectedCount,
      pruned: 0,
      deletedArtifacts: 0,
      deletedBytes: 0,
      storageCleanupFailures: 0,
      candidates: summaries,
    }
  }

  let pruned = 0
  let deletedArtifacts = 0
  let deletedBytes = 0
  let storageCleanupFailures = 0
  for (const candidate of candidates) {
    if (hasReferences(candidate)) continue
    const deleted = await prisma.$transaction(async (tx) => {
      const current = await tx.workspaceImport.findFirst({
        where: { id: candidate.id, projectId: candidate.projectId, status: 'COMPLETED', completedAt: { lt: cutoff } },
        select: { id: true, rootTargetId: true, artifacts: { select: { id: true, storagePath: true, sizeBytes: true } } },
      })
      if (!current) return null
      await tx.artifact.deleteMany({ where: { importId: current.id } })
      await tx.workspaceImport.delete({ where: { id: current.id } })
      if (current.rootTargetId) await tx.target.deleteMany({ where: { id: current.rootTargetId, projectId: candidate.projectId } })
      await tx.workspaceActivity.create({
        data: {
          projectId: candidate.projectId,
          actor: 'Retention',
          eventType: 'workspace.import.pruned',
          message: `Pruned historical import ${current.id} after the configured retention window`,
          data: { importId: current.id, artifactCount: current.artifacts.length, retentionDays },
        },
      })
      return current
    })
    if (!deleted) continue
    pruned += 1
    deletedArtifacts += deleted.artifacts.length
    deletedBytes += deleted.artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0)
    for (const artifact of deleted.artifacts) {
      try {
        await unlink(resolveArtifactStoragePath(artifact.storagePath))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        storageCleanupFailures += 1
        console.warn('Failed to remove pruned REAmon artifact bytes:', error)
      }
    }
  }

  return {
    dryRun: false,
    retentionDays,
    cutoff: cutoff.toISOString(),
    considered: candidates.length,
    protected: protectedCount,
    pruned,
    deletedArtifacts,
    deletedBytes,
    storageCleanupFailures,
    candidates: summaries,
  }
}

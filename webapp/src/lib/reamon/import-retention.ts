import { unlink } from 'node:fs/promises'
import prisma from '@/lib/prisma'
import { removeStagedImport, resolveArtifactStoragePath } from './artifact-storage'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETENTION_DAYS = 90
const MIN_RETENTION_DAYS = 7
const MAX_RETENTION_DAYS = 3650
const MAX_IMPORTS_PER_RUN = 25
const DEFAULT_STAGING_RETENTION_DAYS = 30
const MIN_STAGING_RETENTION_DAYS = 7
const MAX_STAGING_RETENTION_DAYS = 365
const MAX_STALE_IMPORTS_PER_RUN = 25

const INCOMPLETE_IMPORT_STATUSES = ['PENDING', 'UPLOADING', 'FAILED', 'CANCELLED']

export function importRetentionDays(): number {
  const raw = Number(process.env.REAMON_IMPORT_RETENTION_DAYS)
  if (!Number.isFinite(raw)) return DEFAULT_RETENTION_DAYS
  if (raw <= 0) return 0
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.floor(raw)))
}

export function importStagingRetentionDays(): number {
  const raw = Number(process.env.REAMON_IMPORT_STAGING_RETENTION_DAYS)
  if (!Number.isFinite(raw)) return DEFAULT_STAGING_RETENTION_DAYS
  if (raw <= 0) return 0
  return Math.min(MAX_STAGING_RETENTION_DAYS, Math.max(MIN_STAGING_RETENTION_DAYS, Math.floor(raw)))
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
  stagingRetentionDays: number
  cutoff: string | null
  stagingCutoff: string | null
  considered: number
  stagingConsidered: number
  protected: number
  pruned: number
  stagingCancelled: number
  deletedArtifacts: number
  deletedBytes: number
  storageCleanupFailures: number
  stagingCleanupFailures: number
  candidates: ImportRetentionCandidate[]
}

interface StaleImportCandidate {
  id: string
  projectId: string
  updatedAt: Date
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

async function findStaleImports(projectId: string | undefined, cutoff: Date): Promise<StaleImportCandidate[]> {
  return prisma.workspaceImport.findMany({
    where: {
      ...(projectId ? { projectId } : {}),
      status: { in: INCOMPLETE_IMPORT_STATUSES },
      updatedAt: { lt: cutoff },
    },
    orderBy: { updatedAt: 'asc' },
    take: MAX_STALE_IMPORTS_PER_RUN,
    select: { id: true, projectId: true, updatedAt: true },
  }) as unknown as Promise<StaleImportCandidate[]>
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
  const stagingRetentionDays = importStagingRetentionDays()
  const now = input.now || new Date()
  const cutoff = retentionDays > 0 ? new Date(now.getTime() - retentionDays * DAY_MS) : null
  const stagingCutoff = stagingRetentionDays > 0 ? new Date(now.getTime() - stagingRetentionDays * DAY_MS) : null
  const candidates = cutoff ? await findCandidates(input.projectId, cutoff) : []
  const staleImports = stagingCutoff ? await findStaleImports(input.projectId, stagingCutoff) : []
  const summaries = candidates.map((candidate) => candidateSummary(candidate, hasReferences(candidate)))
  const protectedCount = summaries.filter((candidate) => candidate.protectedByReferences).length
  if (input.dryRun !== false) {
    return {
      dryRun: true,
      retentionDays,
      stagingRetentionDays,
      cutoff: cutoff?.toISOString() || null,
      stagingCutoff: stagingCutoff?.toISOString() || null,
      considered: candidates.length,
      stagingConsidered: staleImports.length,
      protected: protectedCount,
      pruned: 0,
      stagingCancelled: 0,
      deletedArtifacts: 0,
      deletedBytes: 0,
      storageCleanupFailures: 0,
      stagingCleanupFailures: 0,
      candidates: summaries,
    }
  }

  let pruned = 0
  let stagingCancelled = 0
  let deletedArtifacts = 0
  let deletedBytes = 0
  let storageCleanupFailures = 0
  let stagingCleanupFailures = 0
  for (const stale of staleImports) {
    const claimed = await prisma.workspaceImport.updateMany({
      where: {
        id: stale.id,
        projectId: stale.projectId,
        status: { in: INCOMPLETE_IMPORT_STATUSES },
        updatedAt: { lt: stagingCutoff! },
      },
      data: {
        status: 'CANCELLED',
        errorSummary: 'Incomplete import expired; staged upload data was cleaned up',
      },
    })
    if (claimed.count !== 1) continue
    stagingCancelled += 1
    try {
      await removeStagedImport(stale.projectId, stale.id)
    } catch (error) {
      stagingCleanupFailures += 1
      console.warn('Failed to remove expired REAmon staged upload bytes:', error)
    }
  }
  for (const candidate of candidates) {
    if (hasReferences(candidate)) continue
    const deleted = await prisma.$transaction(async (tx) => {
      const current = await tx.workspaceImport.findFirst({
        where: { id: candidate.id, projectId: candidate.projectId, status: 'COMPLETED', completedAt: { lt: cutoff! } },
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
    deletedBytes += deleted.artifacts.reduce((total, artifact) => total + Number(artifact.sizeBytes), 0)
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
    stagingRetentionDays,
    cutoff: cutoff?.toISOString() || null,
    stagingCutoff: stagingCutoff?.toISOString() || null,
    considered: candidates.length,
    stagingConsidered: staleImports.length,
    protected: protectedCount,
    pruned,
    stagingCancelled,
    deletedArtifacts,
    deletedBytes,
    storageCleanupFailures,
    stagingCleanupFailures,
    candidates: summaries,
  }
}

import prisma from '@/lib/prisma'
import type { FindingStatus } from './types'

const FINDING_STATUSES = new Set<FindingStatus>(['OPEN', 'REVIEWING', 'ACCEPTED', 'REJECTED', 'VERIFIED'])
const MAX_ACTOR_LENGTH = 128
const MAX_NOTE_LENGTH = 4000

export function isFindingStatus(value: unknown): value is FindingStatus {
  return typeof value === 'string' && FINDING_STATUSES.has(value as FindingStatus)
}

export function normaliseFindingNote(value: string | undefined): string {
  return (value?.trim() || '').slice(0, MAX_NOTE_LENGTH)
}

export async function reviewFinding(
  projectId: string,
  findingId: string,
  status: FindingStatus,
  actor?: string,
  note?: string,
) {
  const reviewer = (actor?.trim() || 'Operator').slice(0, MAX_ACTOR_LENGTH)
  const reviewNote = normaliseFindingNote(note)
  return prisma.$transaction(async (tx) => {
    const finding = await tx.finding.findFirst({
      where: { id: findingId, projectId },
      select: { id: true, title: true, status: true, severity: true, source: true, taskId: true, artifactId: true },
    })
    if (!finding) return null

    const updated = await tx.finding.update({
      where: { id: finding.id },
      data: { status },
      select: { id: true, title: true, status: true, severity: true, source: true, taskId: true, artifactId: true, updatedAt: true },
    })
    await tx.workspaceActivity.create({
      data: {
        projectId,
        actor: reviewer,
        eventType: 'analysis.finding.reviewed',
        message: `Reviewed ${finding.title} as ${status}`,
        data: { findingId, previousStatus: finding.status, status, note: reviewNote },
      },
    })
    return { finding: { ...updated, updatedAt: updated.updatedAt.toISOString() }, note: reviewNote }
  })
}

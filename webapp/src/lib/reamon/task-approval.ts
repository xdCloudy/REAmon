import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'

export type ApprovalDecision = 'approve' | 'reject'
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED'

const MAX_ACTOR_LENGTH = 128
const MAX_REASON_LENGTH = 4000

const approvalTaskSelect = {
  id: true,
  title: true,
  status: true,
  progress: true,
  error: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TaskSelect

type ApprovalTask = Prisma.TaskGetPayload<{ select: typeof approvalTaskSelect }>

export interface TaskApprovalResult {
  outcome: 'APPROVED' | 'REJECTED' | 'SKIPPED'
  approval: {
    id: string
    status: ApprovalStatus
    requestedBy: string
    decidedBy: string | null
    reason: string
    requestedAt: string
    decidedAt: string | null
  }
  task: {
    id: string
    title: string
    status: string
    progress: number
    error: string
    createdAt: string
    updatedAt: string
  }
}

export function taskRequiresApproval(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).requiresApproval === true)
}

function normaliseActor(value: string | undefined): string {
  return (value?.trim() || 'Operator').slice(0, MAX_ACTOR_LENGTH)
}

function normaliseReason(value: string | undefined): string {
  return (value?.trim() || '').slice(0, MAX_REASON_LENGTH)
}

function serialiseTask(task: ApprovalTask): TaskApprovalResult['task'] {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    progress: task.progress,
    error: task.error,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  }
}

function serialiseApproval(approval: {
  id: string
  status: string
  requestedBy: string
  decidedBy: string | null
  reason: string
  requestedAt: Date
  decidedAt: Date | null
}): TaskApprovalResult['approval'] {
  return {
    id: approval.id,
    status: approval.status as ApprovalStatus,
    requestedBy: approval.requestedBy,
    decidedBy: approval.decidedBy,
    reason: approval.reason,
    requestedAt: approval.requestedAt.toISOString(),
    decidedAt: approval.decidedAt?.toISOString() || null,
  }
}

export async function decideTaskApproval(
  projectId: string,
  approvalId: string,
  decision: ApprovalDecision,
  decidedBy?: string,
  reason?: string,
): Promise<TaskApprovalResult | null> {
  const actor = normaliseActor(decidedBy)
  const decisionReason = normaliseReason(reason)
  const nextStatus: ApprovalStatus = decision === 'approve' ? 'APPROVED' : 'REJECTED'
  const nextTaskStatus = decision === 'approve' ? 'QUEUED' : 'CANCELLED'
  const decidedAt = new Date()

  return prisma.$transaction(async (tx) => {
    const approval = await tx.reamonApproval.findFirst({
      where: { id: approvalId, projectId },
      select: {
        id: true,
        status: true,
        requestedBy: true,
        decidedBy: true,
        reason: true,
        requestedAt: true,
        decidedAt: true,
        task: { select: approvalTaskSelect },
      },
    })
    if (!approval) return null

    if (approval.status !== 'PENDING' || approval.task.status !== 'AWAITING_APPROVAL') {
      return {
        outcome: 'SKIPPED' as const,
        approval: serialiseApproval(approval),
        task: serialiseTask(approval.task),
      }
    }

    const changed = await tx.reamonApproval.updateMany({
      where: { id: approvalId, projectId, status: 'PENDING' },
      data: { status: nextStatus, decidedBy: actor, reason: decisionReason, decidedAt },
    })
    if (changed.count !== 1) return null

    const taskChanged = await tx.task.updateMany({
      where: { id: approval.task.id, projectId, status: 'AWAITING_APPROVAL' },
      data: {
        status: nextTaskStatus,
        ...(decision === 'reject' ? { error: decisionReason || 'Rejected by operator', completedAt: decidedAt } : { error: '' }),
      },
    })
    if (taskChanged.count !== 1) return null

    const task = await tx.task.findUnique({ where: { id: approval.task.id }, select: approvalTaskSelect })
    if (!task) return null
    const updatedApproval = {
      ...approval,
      status: nextStatus,
      decidedBy: actor,
      reason: decisionReason,
      decidedAt,
    }
    await tx.workspaceActivity.create({
      data: {
        projectId,
        actor,
        eventType: decision === 'approve' ? 'analysis.task.approved' : 'analysis.task.rejected',
        message: decision === 'approve' ? `Approved ${task.title}` : `Rejected ${task.title}`,
        data: { taskId: task.id, approvalId, decision, reason: decisionReason },
      },
    })
    return {
      outcome: decision === 'approve' ? 'APPROVED' as const : 'REJECTED' as const,
      approval: serialiseApproval(updatedApproval),
      task: serialiseTask(task),
    }
  })
}

export async function listTaskApprovals(projectId: string, status?: ApprovalStatus) {
  const approvals = await prisma.reamonApproval.findMany({
    where: { projectId, ...(status ? { status } : {}) },
    orderBy: { requestedAt: 'desc' },
    take: 100,
    select: {
      id: true,
      status: true,
      requestedBy: true,
      decidedBy: true,
      reason: true,
      requestedAt: true,
      decidedAt: true,
      task: { select: approvalTaskSelect },
    },
  })
  return approvals.map((approval) => ({
    approval: serialiseApproval(approval),
    task: serialiseTask(approval.task),
  }))
}

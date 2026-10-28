import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { getActiveWorkspaceImportSelection } from '@/lib/reamon/inventory-query'

interface RouteParams { params: Promise<{ id: string; taskId: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const INVESTIGATABLE_CAPABILITIES = ['decompile', 'disassemble']

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, taskId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const investigation = await prisma.reamonInvestigationCase.findFirst({
      where: { projectId, taskId },
      select: {
        id: true,
        taskId: true,
        artifactId: true,
        artifactSha256: true,
        capability: true,
        providerId: true,
        providerVersion: true,
        status: true,
        failureEvidence: true,
        history: true,
        revision: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    return NextResponse.json({ investigation }, { headers: NO_STORE })
  } catch (error) {
    console.error('Failed to load REAmon investigation case:', error)
    return NextResponse.json({ error: 'Failed to load investigation case' }, { status: 500, headers: NO_STORE })
  }
}

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId, taskId } = await params
    const user = await requireEffectiveUser()
    if (user instanceof NextResponse) return user
    const access = await requireProjectAccess(user, projectId)
    if (access instanceof NextResponse) return access

    const selection = await getActiveWorkspaceImportSelection(projectId)
    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        projectId,
        status: { in: ['FAILED', 'CANCELLED'] },
        capability: { in: INVESTIGATABLE_CAPABILITIES },
        artifact: { is: selection.artifactWhere },
      },
      select: {
        id: true,
        projectId: true,
        artifactId: true,
        capability: true,
        status: true,
        title: true,
        progressMessage: true,
        error: true,
        result: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        artifact: { select: { sha256: true } },
        provider: { select: { pluginId: true, version: true } },
      },
    })
    if (!task?.artifactId || !task.artifact?.sha256 || !task.capability) {
      return NextResponse.json({ error: 'Only failed analysis runs for the active artifact can be investigated' }, { status: 409, headers: NO_STORE })
    }

    const existing = await prisma.reamonInvestigationCase.findUnique({
      where: { taskId },
      select: { id: true, status: true, revision: true },
    })
    if (existing) return NextResponse.json({ investigation: existing, alreadyQueued: true }, { headers: NO_STORE })

    const observationCount = await prisma.reamonObservation.count({ where: { projectId, taskId } })
    const result = task.result && typeof task.result === 'object' && !Array.isArray(task.result)
      ? task.result as Record<string, unknown>
      : null
    const failureEvidence = {
      schemaVersion: 1,
      taskId: task.id,
      capability: task.capability,
      taskTitle: task.title.slice(0, 500),
      taskStatus: task.status,
      artifactSha256: task.artifact.sha256.toLowerCase(),
      providerId: task.provider?.pluginId ?? null,
      providerVersion: task.provider?.version ?? null,
      lastProgress: task.progressMessage.slice(0, 500),
      failureMessage: task.error.slice(0, 4000),
      startedAt: task.startedAt?.toISOString() ?? null,
      failedAt: task.completedAt?.toISOString() ?? null,
      existingObservationCount: observationCount,
      resultKeys: result ? Object.keys(result).slice(0, 100) : [],
    }

    let investigation
    try {
      investigation = await prisma.reamonInvestigationCase.create({
        data: {
          projectId,
          taskId,
          artifactId: task.artifactId,
          artifactSha256: task.artifact.sha256.toLowerCase(),
          capability: task.capability,
          providerId: task.provider?.pluginId ?? null,
          providerVersion: task.provider?.version ?? null,
          status: 'QUEUED',
          failureEvidence,
          history: [{ event: 'QUEUED', at: new Date().toISOString(), requestedBy: user.userId }],
          requestedBy: user.userId,
        },
        select: { id: true, status: true, revision: true, createdAt: true },
      })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
      const concurrent = await prisma.reamonInvestigationCase.findUnique({
        where: { taskId },
        select: { id: true, status: true, revision: true },
      })
      if (!concurrent) throw error
      return NextResponse.json({ investigation: concurrent, alreadyQueued: true }, { headers: NO_STORE })
    }
    return NextResponse.json({ investigation, alreadyQueued: false }, { status: 201, headers: NO_STORE })
  } catch (error) {
    console.error('Failed to queue REAmon investigation:', error)
    return NextResponse.json({ error: 'Failed to queue investigation' }, { status: 500, headers: NO_STORE })
  }
}

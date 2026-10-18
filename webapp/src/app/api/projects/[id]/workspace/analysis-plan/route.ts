import { NextResponse } from 'next/server'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import prisma from '@/lib/prisma'
import { listWorkspaceFiles, type WorkspaceFileKind } from '@/lib/reamon/inventory-query'
import { buildWorkspaceAnalysisPlan, type WorkspaceAnalysisPlanStep } from '@/lib/reamon/analysis-plan'

interface RouteParams { params: Promise<{ id: string }> }

const KINDS = new Set<WorkspaceFileKind>(['executables', 'source'])

function positiveInteger(value: string | null, label: string, max: number): number | undefined | NextResponse {
  if (value == null) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    return NextResponse.json({ error: `${label} must be an integer between 1 and ${max}` }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  return parsed
}

function nonNegativeInteger(value: string | null, label: string, max: number): number | undefined | NextResponse {
  if (value == null) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    return NextResponse.json({ error: `${label} must be a non-negative integer no greater than ${max}` }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  return parsed
}

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const url = new URL(request.url)
    const rawKind = url.searchParams.get('kind') || undefined
    const kind = rawKind && KINDS.has(rawKind as WorkspaceFileKind) ? rawKind as WorkspaceFileKind : undefined
    if (rawKind && !kind) return NextResponse.json({ error: 'Unsupported workspace analysis kind' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })

    const limit = positiveInteger(url.searchParams.get('limit'), 'limit', 100)
    if (limit instanceof NextResponse) return limit
    const offset = nonNegativeInteger(url.searchParams.get('offset'), 'offset', 100000)
    if (offset instanceof NextResponse) return offset

    const search = url.searchParams.get('search') || undefined
    const format = url.searchParams.get('format') || undefined
    const capability = url.searchParams.get('capability') || undefined
    if (search && search.length > 200) return NextResponse.json({ error: 'search must be at most 200 characters' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    if (format && format.length > 64) return NextResponse.json({ error: 'format must be at most 64 characters' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    if (capability && capability.length > 64) return NextResponse.json({ error: 'capability must be at most 64 characters' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })

    const query = { search, format, kind, capability, limit, offset }
    const inventory = await listWorkspaceFiles(projectId, { search, format, kind, limit, offset })
    const plan = buildWorkspaceAnalysisPlan(projectId, inventory, query)
    const latestScan = await prisma.workspaceActivity.findFirst({
      where: { projectId, eventType: 'analysis.project.scanned' },
      orderBy: { createdAt: 'desc' },
      select: { data: true, createdAt: true },
    })
    const clears = await prisma.workspaceActivity.findMany({
      where: {
        projectId,
        eventType: 'analysis.proposal.cleared',
        ...(latestScan ? { createdAt: { gt: latestScan.createdAt } } : {}),
      },
      select: { data: true },
    })
    const clearedProposalIds = new Set(clears
      .map((activity) => activity.data && typeof activity.data === 'object' && !Array.isArray(activity.data)
        ? (activity.data as Record<string, unknown>).proposalId
        : null)
      .filter((proposalId): proposalId is string => typeof proposalId === 'string'))
    const visibleSteps = plan.steps.filter((step) => !clearedProposalIds.has(step.id))
    const artifactIds = [...new Set(visibleSteps.map((step) => step.artifactId))]
    const providerIds = [...new Set(visibleSteps.map((step) => step.provider.pluginId))]
    const tasks = artifactIds.length && providerIds.length
      ? await prisma.task.findMany({
          where: { projectId, artifactId: { in: artifactIds }, provider: { pluginId: { in: providerIds } } },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            artifactId: true,
            capability: true,
            status: true,
            progress: true,
            progressMessage: true,
            error: true,
            leaseHeartbeatAt: true,
            updatedAt: true,
            provider: { select: { pluginId: true } },
          },
        })
      : []
    const taskByProposal = new Map<string, typeof tasks[number]>()
    const taskCountByProposal = new Map<string, number>()
    for (const task of tasks) {
      if (!task.artifactId || !task.provider?.pluginId || !task.capability) continue
      const key = `${task.artifactId}:${task.provider.pluginId}:${task.capability.toLowerCase()}`
      taskCountByProposal.set(key, (taskCountByProposal.get(key) || 0) + 1)
      if (!taskByProposal.has(key)) taskByProposal.set(key, task)
    }
    const steps: WorkspaceAnalysisPlanStep[] = visibleSteps.map((step) => {
      const key = `${step.artifactId}:${step.provider.pluginId}:${step.capability.toLowerCase()}`
      const task = taskByProposal.get(key)
      return {
        ...step,
        previousRunCount: taskCountByProposal.get(key) || 0,
        latestTask: task ? {
          id: task.id,
          status: task.status,
          progress: task.progress,
          progressMessage: task.progressMessage,
          error: task.error,
          leaseHeartbeatAt: task.leaseHeartbeatAt?.toISOString() || null,
          updatedAt: task.updatedAt.toISOString(),
        } : null,
      }
    })
    const scanData = latestScan?.data && typeof latestScan.data === 'object' && !Array.isArray(latestScan.data)
      ? latestScan.data as Record<string, unknown>
      : null
    return NextResponse.json({
      ...plan,
      steps,
      proposedSteps: Math.max(0, plan.proposedSteps - (plan.steps.length - steps.length)),
      clearedProposalIds: [...clearedProposalIds],
      lastProjectScan: latestScan && scanData ? {
        scannedAt: latestScan.createdAt.toISOString(),
        artifactsScanned: Number(scanData.artifactsScanned) || 0,
        proposalCount: Number(scanData.proposalCount) || 0,
        previousTasks: Number(scanData.previousTasks) || 0,
        findings: Number(scanData.findings) || 0,
        hypotheses: Number(scanData.hypotheses) || 0,
        evidence: Number(scanData.evidence) || 0,
      } : null,
    }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    console.error('Failed to build REAmon workspace analysis plan:', error)
    return NextResponse.json({ error: 'Failed to build workspace analysis plan' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}


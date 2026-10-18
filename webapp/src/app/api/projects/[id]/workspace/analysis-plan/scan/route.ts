import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { requireEffectiveUser, requireProjectAccess } from '@/lib/access'
import { listWorkspaceFiles } from '@/lib/reamon/inventory-query'
import { buildWorkspaceAnalysisPlan } from '@/lib/reamon/analysis-plan'

interface RouteParams { params: Promise<{ id: string }> }

const PAGE_SIZE = 500
const MAX_SCAN_ARTIFACTS = 100_000

export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id: projectId } = await params
    const effectiveUser = await requireEffectiveUser()
    if (effectiveUser instanceof NextResponse) return effectiveUser
    const access = await requireProjectAccess(effectiveUser, projectId)
    if (access instanceof NextResponse) return access

    const firstPage = await listWorkspaceFiles(projectId, { limit: PAGE_SIZE })
    const artifacts = [...firstPage.artifacts]
    for (let offset = PAGE_SIZE; offset < firstPage.total && offset < MAX_SCAN_ARTIFACTS; offset += PAGE_SIZE) {
      const page = await listWorkspaceFiles(projectId, { limit: PAGE_SIZE, offset })
      artifacts.push(...page.artifacts)
      if (!page.hasMore) break
    }
    const inventory = {
      ...firstPage,
      artifacts,
      hasMore: firstPage.total > artifacts.length,
    }
    const plan = buildWorkspaceAnalysisPlan(projectId, inventory)
    const [previousTasks, findings, hypotheses, evidence] = await Promise.all([
      prisma.task.count({ where: { projectId } }),
      prisma.finding.count({ where: { projectId } }),
      prisma.hypothesis.count({ where: { projectId } }),
      prisma.evidence.count({ where: { projectId } }),
    ])
    const scan = {
      artifactsScanned: artifacts.length,
      proposalCount: plan.proposedSteps,
      previousTasks,
      findings,
      hypotheses,
      evidence,
    }
    const activity = await prisma.workspaceActivity.create({
      data: {
        projectId,
        actor: effectiveUser.userId,
        eventType: 'analysis.project.scanned',
        message: `Scanned ${artifacts.length.toLocaleString()} workspace artifacts and reused saved analysis history`,
        data: scan,
      },
      select: { createdAt: true },
    })

    return NextResponse.json({ ...scan, scannedAt: activity.createdAt.toISOString() }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('Failed to scan REAmon project analysis context:', error)
    return NextResponse.json({ error: 'Failed to scan project analysis context' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

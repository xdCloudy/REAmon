import { assertMcpProjectAccess, requireScope } from '@/lib/mcpAuth'
import { enforceRate, type McpContext } from '@/lib/mcp/tools'
import { listWorkspaceFiles } from '@/lib/reamon/inventory-query'
import {
  buildWorkspaceAnalysisPlan,
  type WorkspaceAnalysisPlanQuery,
} from '@/lib/reamon/analysis-plan'
import { McpToolError } from '@/lib/mcp/errors'

export interface WorkspacePlanAnalysisArgs extends WorkspaceAnalysisPlanQuery {
  projectId: string
}

export async function planWorkspaceAnalysis(
  ctx: McpContext,
  args: WorkspacePlanAnalysisArgs,
) {
  requireScope(ctx.token, 'recon:read')
  enforceRate(ctx, 'read')
  await assertMcpProjectAccess(ctx.token.userId, args.projectId)

  const inventory = await listWorkspaceFiles(args.projectId, {
    search: args.search,
    format: args.format,
    kind: args.kind,
    limit: args.limit,
    offset: args.offset,
  })
  const plan = buildWorkspaceAnalysisPlan(args.projectId, inventory, args)
  if ((args.stepOffset || 0) > 0 && !args.snapshotId) {
    throw new McpToolError('ANALYSIS_PLAN_SNAPSHOT_REQUIRED: snapshotId from the first proposal page is required to continue step paging.', 'ANALYSIS_PLAN_SNAPSHOT_REQUIRED')
  }
  if (args.snapshotId && args.snapshotId !== plan.snapshotId) {
    throw new McpToolError('ANALYSIS_PLAN_SNAPSHOT_STALE: workspace proposals changed. Restart proposal paging from stepOffset 0 without snapshotId.', 'ANALYSIS_PLAN_SNAPSHOT_STALE')
  }
  return plan
}


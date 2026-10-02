import { assertMcpProjectAccess, requireScope } from '@/lib/mcpAuth'
import { enforceRate, type McpContext } from '@/lib/mcp/tools'
import { listWorkspaceFiles } from '@/lib/reamon/inventory-query'
import {
  buildWorkspaceAnalysisPlan,
  type WorkspaceAnalysisPlanQuery,
} from '@/lib/reamon/analysis-plan'

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
  return buildWorkspaceAnalysisPlan(args.projectId, inventory, args)
}


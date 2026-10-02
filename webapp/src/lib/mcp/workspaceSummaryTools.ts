import { assertMcpProjectAccess, requireScope } from '@/lib/mcpAuth'
import { enforceRate, type McpContext } from '@/lib/mcp/tools'
import { getWorkspaceInventorySummary } from '@/lib/reamon/inventory-summary'
import { McpToolError } from '@/lib/mcp/errors'

export async function getWorkspaceSummary(ctx: McpContext, projectId: string) {
  requireScope(ctx.token, 'recon:read')
  enforceRate(ctx, 'read')
  await assertMcpProjectAccess(ctx.token.userId, projectId)

  const summary = await getWorkspaceInventorySummary(projectId)
  if (!summary) throw new McpToolError('Workspace not found.', 'not_found')
  return summary
}

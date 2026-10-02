/**
 * Target-agnostic REAmon workspace reads for external agents.
 *
 * These tools deliberately use the same logical inventory service as the web
 * workspace. They never expose storagePath or ask an agent to understand the
 * host filesystem. The service also selects only the active import snapshot,
 * so a refresh does not make old and new copies appear as one workspace.
 */
import { assertMcpProjectAccess, requireScope } from '@/lib/mcpAuth'
import { McpToolError } from '@/lib/mcp/errors'
import {
  getWorkspaceArtifact as queryWorkspaceArtifact,
  listWorkspaceFiles as queryWorkspaceFiles,
  type WorkspaceFileQuery,
} from '@/lib/reamon/inventory-query'
import { enforceRate, type McpContext } from '@/lib/mcp/tools'

export interface WorkspaceListFilesArgs extends WorkspaceFileQuery {
  projectId: string
}

export interface WorkspaceGetArtifactArgs {
  projectId: string
  artifactId: string
}

export async function listWorkspaceInventory(
  ctx: McpContext,
  args: WorkspaceListFilesArgs,
) {
  requireScope(ctx.token, 'recon:read')
  enforceRate(ctx, 'read')
  await assertMcpProjectAccess(ctx.token.userId, args.projectId)

  const result = await queryWorkspaceFiles(args.projectId, {
    search: args.search,
    format: args.format,
    kind: args.kind,
    limit: args.limit,
    offset: args.offset,
  })
  return { projectId: args.projectId, ...result }
}

export async function getWorkspaceArtifact(
  ctx: McpContext,
  args: WorkspaceGetArtifactArgs,
) {
  requireScope(ctx.token, 'recon:read')
  enforceRate(ctx, 'read')
  await assertMcpProjectAccess(ctx.token.userId, args.projectId)

  const artifact = await queryWorkspaceArtifact(args.projectId, args.artifactId)
  if (!artifact) throw new McpToolError('Workspace artifact not found.', 'not_found')
  return { projectId: args.projectId, artifact }
}

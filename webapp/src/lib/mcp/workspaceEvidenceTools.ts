/** Authorized MCP wrappers for shared project-scoped evidence reads. */
import { assertMcpProjectAccess, requireScope } from '@/lib/mcpAuth'
import { McpToolError } from '@/lib/mcp/errors'
import { enforceRate, type McpContext } from '@/lib/mcp/tools'
import {
  listPersistedWorkspaceEvidence,
  readPersistedWorkspaceEvidence,
  WorkspaceEvidenceError,
  type WorkspaceGetEvidenceArgs,
  type WorkspaceListEvidenceArgs,
} from '@/lib/reamon/workspace-evidence'

export type { WorkspaceGetEvidenceArgs, WorkspaceListEvidenceArgs } from '@/lib/reamon/workspace-evidence'

async function prepareEvidenceRead(ctx: McpContext, projectId: string) {
  requireScope(ctx.token, 'recon:read')
  enforceRate(ctx, 'read')
  await assertMcpProjectAccess(ctx.token.userId, projectId)
}

function mcpError(error: unknown): never {
  if (error instanceof WorkspaceEvidenceError) throw new McpToolError(error.message, error.code)
  throw error
}

export async function listWorkspaceEvidence(ctx: McpContext, args: WorkspaceListEvidenceArgs) {
  await prepareEvidenceRead(ctx, args.projectId)
  try {
    return await listPersistedWorkspaceEvidence(args)
  } catch (error) {
    return mcpError(error)
  }
}

export async function getWorkspaceEvidence(ctx: McpContext, args: WorkspaceGetEvidenceArgs) {
  await prepareEvidenceRead(ctx, args.projectId)
  try {
    return await readPersistedWorkspaceEvidence(args)
  } catch (error) {
    return mcpError(error)
  }
}

/**
 * The MCP server's Kali calls into the agent.
 *
 * Same shape as graphClient.ts and for the same reason: the MCP layer resolves
 * a personal access token to ONE user and then hands that resolved identity to
 * the agent, which owns every decision about the kali-sandbox. The webapp holds
 * no MCP_AUTH_TOKEN and speaks no MCP to the worker, so a webapp compromise
 * does not become a channel into the target-facing tier.
 *
 * Every call carries an explicit timeout. An inherited unbounded default would
 * let a slow agent hold an MCP request open until the client gives up, which
 * the caller cannot distinguish from an empty answer.
 */
import { agentBaseUrl } from '@/lib/agentFetch'
import { internalKeyHeaders } from '@/lib/agentAuth'
import { McpToolError } from '@/lib/mcp/errors'

const TOOLBOX_TIMEOUT_MS = 10_000

// The catalogue is static per build (it is a constant in the agent image), so
// one successful fetch is enough for the life of the process. After that
// kali_toolbox genuinely cannot fail on a dependency, which is what makes it
// the tool that still answers when the kali-sandbox is down.
let toolboxCache: string | null = null

export async function kaliToolboxDoc(): Promise<string> {
  if (toolboxCache) return toolboxCache
  let resp: Response
  try {
    resp = await fetch(`${agentBaseUrl()}/kali/toolbox`, {
      headers: internalKeyHeaders(),
      signal: AbortSignal.timeout(TOOLBOX_TIMEOUT_MS),
    })
  } catch (err) {
    console.error('[mcp] kali toolbox transport error:', err)
    // NEVER an empty catalogue: "this image ships no tools" and "could not ask"
    // must not look the same to an agent deciding what it can run.
    throw new McpToolError('The Kali toolbox is unavailable.', 'agent_unreachable')
  }
  if (!resp.ok) {
    console.error(`[mcp] kali toolbox failed (${resp.status})`)
    throw new McpToolError('The Kali toolbox could not be loaded.', 'agent_failed')
  }
  const body = (await resp.json()) as { toolbox?: unknown }
  if (typeof body.toolbox !== 'string' || !body.toolbox) {
    // Logged like the !resp.ok branch above. Without this the endpoint
    // answering 200 with the WRONG SHAPE left nothing in any log on either
    // side, and the only way to find it was to reproduce the fetch by hand.
    console.error(
      '[mcp] kali toolbox returned an unexpected body shape:',
      `${typeof body} ${JSON.stringify(body).slice(0, 200)}`
    )
    throw new McpToolError('The Kali toolbox could not be loaded.', 'agent_failed')
  }
  toolboxCache = body.toolbox
  return toolboxCache
}

/** Test seam: the cache is process-global by design. */
export function __resetToolboxCache(): void {
  toolboxCache = null
}

// --- exec ---------------------------------------------------------------------

/**
 * Comfortably past the agent's own KALI_EXEC_MAX_WAIT (60s) so the inline wait
 * is what ends the call, not this. A timeout here would leave the command
 * running with the caller holding no job id to poll or cancel it with.
 */
const EXEC_TIMEOUT_MS = 90_000
const POLL_TIMEOUT_MS = 30_000

export interface KaliJob {
  jobId: string
  status: string
  exitCode: number | null
  output: string
  nextCursor: number
  truncated?: boolean
  command?: string
  /** The agent's reason a finished job failed, e.g. the 300s sandbox cap. */
  failure?: string
  startedAt?: string | null
  endedAt?: string | null
}

/** The agent answers snake_case; the MCP surface speaks camelCase throughout. */
function toJob(raw: Record<string, unknown>): KaliJob {
  return {
    jobId: String(raw.job_id ?? ''),
    status: String(raw.status ?? 'unknown'),
    exitCode: typeof raw.exit_code === 'number' ? raw.exit_code : null,
    output: typeof raw.output === 'string' ? raw.output : '',
    nextCursor: typeof raw.next_cursor === 'number' ? raw.next_cursor : 0,
    ...(raw.truncated ? { truncated: true } : {}),
    ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
    // WHY a finished job failed. Dropping it left "exitCode 1" with no reason,
    // and the most common reason is the sandbox's 300s cap - which an agent
    // can only act on if it is told.
    ...(typeof raw.error === 'string' && raw.error ? { failure: raw.error } : {}),
    startedAt: (raw.started_at as string) ?? null,
    endedAt: (raw.ended_at as string) ?? null,
  }
}

/**
 * Turn an agent failure into a caller-facing message.
 *
 * A 400 carries the admission refusal, which is written FOR the caller and says
 * what to change; it is the one upstream message quoted verbatim. Everything
 * else becomes a fixed line, per the errors.ts rule.
 */
async function execFailure(resp: Response): Promise<never> {
  let detail: Record<string, unknown> = {}
  try {
    detail = await resp.json()
  } catch {
    // Non-JSON body: nothing safe to quote.
  }
  const message = typeof detail.error === 'string' ? detail.error : ''

  if (resp.status === 400) {
    throw new McpToolError(message || 'That command was refused.', 'refused')
  }
  // 404 is deliberately NOT quoted: the agent says "no such command" for a
  // missing job and for another project's job alike, and that sameness is the
  // anti-enumeration property.
  if (resp.status === 404) throw new McpToolError('No such command.', 'not_found')
  if (resp.status === 429) {
    throw new McpToolError(
      message || 'The sandbox is busy. Retry shortly.',
      'sandbox_busy'
    )
  }
  if (resp.status === 503) {
    throw new McpToolError(message || 'The sandbox is unavailable.', 'sandbox_unavailable')
  }
  // Any OTHER 4xx: the agent is telling the caller something it can act on, and
  // the enumerated branches above cannot be the complete list forever. The
  // cancel endpoint already answers 409 with the reason a job could not be
  // stopped, and that reason was being replaced by a flat "could not be run" -
  // the same defect a sibling session found in graphClient.ts, where a refusal
  // the caller could have fixed was collapsed into five generic words.
  //
  // 5xx still degrades: those bodies are raw exception text (host paths, image
  // names), which errors.ts forbids returning.
  if (resp.status < 500 && message) {
    console.error(`[mcp] kali exec ${resp.status}:`, message.slice(0, 200))
    throw new McpToolError(message, 'agent_refused')
  }
  console.error(`[mcp] kali exec failed (${resp.status}):`, JSON.stringify(detail))
  throw new McpToolError('The command could not be run.', 'agent_failed')
}

async function agentJson(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  what: string
): Promise<KaliJob> {
  let resp: Response
  try {
    resp = await fetch(`${agentBaseUrl()}${path}`, {
      ...init,
      headers: internalKeyHeaders(
        init.body ? { 'Content-Type': 'application/json' } : {}
      ),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    console.error(`[mcp] kali ${what} transport error:`, err)
    // Never an empty result: a command whose outcome is unknown must not read
    // as a command that produced nothing.
    throw new McpToolError('The sandbox is unreachable.', 'agent_unreachable')
  }
  if (!resp.ok) await execFailure(resp)
  return toJob((await resp.json()) as Record<string, unknown>)
}

export async function kaliExec(
  userId: string,
  projectId: string,
  command: string,
  waitSeconds?: number
): Promise<KaliJob> {
  return agentJson(
    '/kali/exec',
    {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        project_id: projectId,
        command,
        ...(waitSeconds === undefined ? {} : { wait_seconds: waitSeconds }),
      }),
    },
    EXEC_TIMEOUT_MS,
    'exec'
  )
}

export async function kaliJobStatus(
  projectId: string,
  jobId: string,
  cursor: number
): Promise<KaliJob> {
  const qs = new URLSearchParams({ project_id: projectId, cursor: String(cursor) })
  return agentJson(
    `/kali/exec/${encodeURIComponent(jobId)}?${qs}`,
    { method: 'GET' },
    POLL_TIMEOUT_MS,
    'poll'
  )
}

export async function kaliJobCancel(projectId: string, jobId: string): Promise<KaliJob> {
  const qs = new URLSearchParams({ project_id: projectId })
  return agentJson(
    `/kali/exec/${encodeURIComponent(jobId)}/cancel?${qs}`,
    { method: 'POST' },
    POLL_TIMEOUT_MS,
    'cancel'
  )
}

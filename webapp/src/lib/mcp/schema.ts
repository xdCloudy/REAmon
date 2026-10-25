/**
 * Shared MCP server schema (zod) - used by both client form validation and
 * server-side API route validation.
 *
 * Mirrors the agentic/mcp_registry.py pydantic schema. Single source of truth
 * for both ends of the wire.
 */

import { z } from 'zod'

export const PHASES = ['informational', 'exploitation', 'post_exploitation'] as const
export type Phase = (typeof PHASES)[number]

export const TRANSPORTS = ['sse', 'streamable_http', 'stdio'] as const
export type Transport = (typeof TRANSPORTS)[number]

/** Tool names reserved by built-in / system tools - user MCP tools must not use these. */
export const BUILTIN_RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Built-in (Python) tools. graph_summary and graph_schema ship on BOTH the
  // agent and the inbound MCP server from one definition; omitting them here
  // let a user-registered plugin shadow a built-in graph tool with its own.
  'query_graph', 'graph_summary', 'graph_schema',
  'web_search', 'cve_intel', 'shodan', 'google_dork',
  'execute_code', 'tradecraft_lookup',
  // System MCP-backed tools (the 5 baseline kali-sandbox servers)
  'execute_curl', 'execute_naabu', 'execute_httpx', 'execute_subfinder',
  'execute_amass', 'execute_arjun', 'execute_ffuf', 'execute_gau',
  'execute_jsluice', 'execute_katana', 'execute_wpscan',
  'execute_nmap', 'execute_nuclei', 'kali_shell', 'execute_playwright',
  'execute_hydra', 'metasploit_console', 'msf_restart',
])

/** Server IDs reserved by system MCP servers - user IDs must not collide. */
export const SYSTEM_SERVER_IDS: ReadonlySet<string> = new Set([
  'network_recon', 'nmap', 'nuclei', 'metasploit', 'playwright',
])

const ID_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/

export const toolSpecSchema = z.object({
  name: z.string().min(1, 'tool name is required').regex(
    /^[a-zA-Z_][a-zA-Z0-9_]*$/,
    'tool name must be a valid identifier (letters, digits, underscore; no leading digit)',
  ),
  purpose: z.string().min(1, 'purpose is required'),
  when_to_use: z.string().min(1, 'when_to_use is required'),
  args_format: z.string().min(1, 'args_format is required'),
  description: z.string().min(1, 'description is required'),
  default_phases: z.array(z.enum(PHASES)).optional(),
})

export const MASK_PREFIX = '••••'

export const bearerAuthSchema = z.object({
  type: z.literal('bearer'),
  token: z.string().optional(),
  token_env_var: z.string().optional(),
})
  .refine(
    v => !!(v.token && v.token.length > 0) || !!(v.token_env_var && v.token_env_var.length > 0),
    { message: "auth requires a non-empty 'token' (bearer token)" },
  )

export const mcpServerSchema = z.object({
  id: z.string()
    .min(1, 'id is required')
    .regex(ID_RE, 'id must start with a letter, digit, or underscore and contain only letters, digits, underscores, and hyphens')
    .refine(v => !SYSTEM_SERVER_IDS.has(v), {
      message: 'this id is reserved for a system MCP server',
    }),
  name: z.string().min(1, 'name is required'),
  description: z.string().default(''),
  enabled: z.boolean().default(true),
  transport: z.enum(TRANSPORTS),
  default_phases: z.array(z.enum(PHASES)).default([...PHASES]),
  tags: z.array(z.string()).default([]),

  // HTTP-only
  url: z.string().url('must be a valid URL').optional().or(z.literal('')),
  headers: z.record(z.string(), z.string()).default({}),
  auth: bearerAuthSchema.optional(),
  connect_timeout: z.number().int().positive().default(60),
  read_timeout: z.number().int().positive().default(600),

  // stdio-only
  command: z.string().optional().or(z.literal('')),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional().or(z.literal('')),
  encoding: z.string().default('utf-8'),

  tools: z.array(toolSpecSchema).default([]),
})
  .superRefine((srv, ctx) => {
    if (srv.transport === 'sse' || srv.transport === 'streamable_http') {
      if (!srv.url) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'url is required for HTTP transports' })
      }
    } else if (srv.transport === 'stdio') {
      if (!srv.command) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'command is required for stdio transport' })
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transport'],
        message: 'stdio MCP servers are disabled until they can run in an isolated per-user worker',
      })
    }

    // Tool name uniqueness within server
    const seen = new Set<string>()
    srv.tools.forEach((t, i) => {
      if (seen.has(t.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tools', i, 'name'],
          message: `duplicate tool name '${t.name}' within this server`,
        })
      }
      seen.add(t.name)

      if (BUILTIN_RESERVED_TOOL_NAMES.has(t.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tools', i, 'name'],
          message: `tool name '${t.name}' collides with a built-in tool`,
        })
      }
    })
  })

export type MCPServer = z.infer<typeof mcpServerSchema>
export type ToolSpec = z.infer<typeof toolSpecSchema>

/** Validate the full mcpServers array, including cross-server uniqueness checks. */
export function validateMcpServers(servers: unknown): {
  valid: MCPServer[]
  errors: { serverId: string; path: string[]; message: string }[]
} {
  if (!Array.isArray(servers)) {
    return { valid: [], errors: [{ serverId: '<root>', path: [], message: 'mcpServers must be an array' }] }
  }

  const errors: { serverId: string; path: string[]; message: string }[] = []
  const valid: MCPServer[] = []
  const seenIds = new Set<string>()
  const seenToolNames = new Set<string>()

  servers.forEach((entry, idx) => {
    const sid = (entry && typeof entry === 'object' && 'id' in entry && typeof (entry as { id: unknown }).id === 'string')
      ? (entry as { id: string }).id
      : `<index ${idx}>`

    const parsed = mcpServerSchema.safeParse(entry)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({ serverId: sid, path: issue.path.map(String), message: issue.message })
      }
      return
    }

    const srv = parsed.data
    if (seenIds.has(srv.id)) {
      errors.push({ serverId: srv.id, path: ['id'], message: `duplicate server id '${srv.id}'` })
      return
    }

    let collision = false
    for (const t of srv.tools) {
      if (seenToolNames.has(t.name)) {
        errors.push({
          serverId: srv.id, path: ['tools', t.name],
          message: `tool name '${t.name}' is already declared by another server`,
        })
        collision = true
      }
    }
    if (collision) return

    seenIds.add(srv.id)
    for (const t of srv.tools) seenToolNames.add(t.name)
    valid.push(srv)
  })

  return { valid, errors }
}

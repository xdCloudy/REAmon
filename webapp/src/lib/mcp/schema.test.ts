/**
 * Unit tests for the MCP server zod schema. Mirrors the pydantic checks in
 * agentic/tests/test_mcp_registry.py — both must enforce the same shape.
 *
 * Run: npx vitest run src/lib/mcp/schema.test.ts
 */

import { describe, test, expect } from 'vitest'
import {
  mcpServerSchema,
  validateMcpServers,
  PHASES,
  TRANSPORTS,
  BUILTIN_RESERVED_TOOL_NAMES,
  SYSTEM_SERVER_IDS,
  type MCPServer,
} from './schema'

const tool = (over: Record<string, unknown> = {}) => ({
  name: 'do_thing',
  purpose: 'Does the thing',
  when_to_use: 'When you need a thing done',
  args_format: '"x":"y"',
  description: 'A multi-line description.',
  ...over,
})

const httpServer = (over: Record<string, unknown> = {}) => ({
  id: 'myhttp',
  name: 'My HTTP MCP',
  transport: 'streamable_http',
  url: 'http://example.local:8080/mcp',
  tools: [],
  ...over,
})

const stdioServer = (over: Record<string, unknown> = {}) => ({
  id: 'mystdio',
  name: 'My Stdio MCP',
  transport: 'stdio',
  command: 'uvx',
  args: ['mcp-server-time'],
  tools: [],
  ...over,
})

describe('PHASES + TRANSPORTS constants', () => {
  test('phases match the agent\'s expected set', () => {
    expect(PHASES).toEqual(['informational', 'exploitation', 'post_exploitation'])
  })
  test('transports match the agent\'s supported list', () => {
    expect(TRANSPORTS).toEqual(['sse', 'streamable_http', 'stdio'])
  })
})

describe('SYSTEM_SERVER_IDS', () => {
  test('reserves all 5 baseline MCP IDs', () => {
    for (const id of ['network_recon', 'nmap', 'nuclei', 'metasploit', 'playwright']) {
      expect(SYSTEM_SERVER_IDS.has(id)).toBe(true)
    }
  })
})

describe('BUILTIN_RESERVED_TOOL_NAMES', () => {
  test('includes core built-ins', () => {
    expect(BUILTIN_RESERVED_TOOL_NAMES.has('query_graph')).toBe(true)
    expect(BUILTIN_RESERVED_TOOL_NAMES.has('execute_nmap')).toBe(true)
    expect(BUILTIN_RESERVED_TOOL_NAMES.has('kali_shell')).toBe(true)
  })
})

describe('mcpServerSchema — http transports', () => {
  test('valid streamable_http server passes', () => {
    const r = mcpServerSchema.safeParse(httpServer())
    expect(r.success).toBe(true)
  })

  test('valid sse server passes', () => {
    const r = mcpServerSchema.safeParse(httpServer({ transport: 'sse' }))
    expect(r.success).toBe(true)
  })

  test('http requires url', () => {
    const r = mcpServerSchema.safeParse(httpServer({ url: '' }))
    expect(r.success).toBe(false)
  })

  test('rejects invalid url', () => {
    const r = mcpServerSchema.safeParse(httpServer({ url: 'not a url' }))
    expect(r.success).toBe(false)
  })
})

describe('mcpServerSchema — stdio transport', () => {
  test('user-configured stdio is rejected until isolated execution is available', () => {
    const r = mcpServerSchema.safeParse(stdioServer())
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.message.includes('isolated per-user worker'))).toBe(true)
    }
  })

  test('stdio requires command', () => {
    const r = mcpServerSchema.safeParse(stdioServer({ command: '' }))
    expect(r.success).toBe(false)
  })
})

describe('mcpServerSchema — id rules', () => {
  test('rejects whitespace in id', () => {
    const r = mcpServerSchema.safeParse(httpServer({ id: 'has space' }))
    expect(r.success).toBe(false)
  })

  test('rejects system-reserved id', () => {
    const r = mcpServerSchema.safeParse(httpServer({ id: 'nmap' }))
    expect(r.success).toBe(false)
  })

  test('accepts hyphens, underscores, digits', () => {
    const r = mcpServerSchema.safeParse(httpServer({ id: 'my-srv_1' }))
    expect(r.success).toBe(true)
  })
})

describe('mcpServerSchema — tool rules', () => {
  test('rejects tool missing required field', () => {
    const r = mcpServerSchema.safeParse(httpServer({
      tools: [tool({ when_to_use: '' })],
    }))
    expect(r.success).toBe(false)
  })

  test('rejects duplicate tool name within server', () => {
    const r = mcpServerSchema.safeParse(httpServer({
      tools: [tool({ name: 't1' }), tool({ name: 't1' })],
    }))
    expect(r.success).toBe(false)
  })

  test('rejects tool name colliding with built-in', () => {
    const r = mcpServerSchema.safeParse(httpServer({
      tools: [tool({ name: 'query_graph' })],
    }))
    expect(r.success).toBe(false)
  })

  test('rejects tool name with space', () => {
    const r = mcpServerSchema.safeParse(httpServer({
      tools: [tool({ name: 'has space' })],
    }))
    expect(r.success).toBe(false)
  })

  test('accepts well-formed tool', () => {
    const r = mcpServerSchema.safeParse(httpServer({
      tools: [tool({ name: 'my_unique_tool' })],
    }))
    expect(r.success).toBe(true)
  })
})

describe('mcpServerSchema — auth', () => {
  test('accepts bearer auth with env var name', () => {
    const r = mcpServerSchema.safeParse(httpServer({
      auth: { type: 'bearer', token_env_var: 'MY_TOKEN' },
    }))
    expect(r.success).toBe(true)
  })

  test('accepts bearer auth with direct token literal', () => {
    const r = mcpServerSchema.safeParse(httpServer({
      auth: { type: 'bearer', token: 'ghp_abc123literal' },
    }))
    expect(r.success).toBe(true)
  })

  test('accepts bearer auth with both fields (direct wins at runtime)', () => {
    const r = mcpServerSchema.safeParse(httpServer({
      auth: { type: 'bearer', token: 'direct', token_env_var: 'FALLBACK' },
    }))
    expect(r.success).toBe(true)
  })

  test('rejects bearer auth with neither token nor token_env_var', () => {
    const r = mcpServerSchema.safeParse(httpServer({
      auth: { type: 'bearer' },
    }))
    expect(r.success).toBe(false)
  })

  test('rejects bearer auth with empty token + empty env var', () => {
    const r = mcpServerSchema.safeParse(httpServer({
      auth: { type: 'bearer', token: '', token_env_var: '' },
    }))
    expect(r.success).toBe(false)
  })
})

describe('mcpServerSchema — defaults', () => {
  test('default_phases defaults to all three', () => {
    const r = mcpServerSchema.safeParse(httpServer())
    expect(r.success).toBe(true)
    if (r.success) {
      expect(new Set(r.data.default_phases)).toEqual(new Set(PHASES))
    }
  })

  test('enabled defaults to true', () => {
    const r = mcpServerSchema.safeParse(httpServer())
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.enabled).toBe(true)
    }
  })
})

describe('validateMcpServers (cross-server)', () => {
  test('rejects non-array', () => {
    const r = validateMcpServers('not an array')
    expect(r.valid.length).toBe(0)
    expect(r.errors.length).toBeGreaterThan(0)
  })

  test('rejects duplicate ids across entries', () => {
    const r = validateMcpServers([
      httpServer({ id: 'dup' }),
      httpServer({ id: 'dup' }),
    ])
    expect(r.valid.length).toBe(1)  // first wins
    expect(r.errors.some(e => /duplicate/i.test(e.message))).toBe(true)
  })

  test('rejects duplicate tool names across servers', () => {
    const r = validateMcpServers([
      httpServer({ id: 'a', tools: [tool({ name: 'shared' })] }),
      httpServer({ id: 'b', tools: [tool({ name: 'shared' })] }),
    ])
    // The second server is rejected entirely because of the collision.
    expect(r.valid.length).toBe(1)
    expect(r.valid[0].id).toBe('a')
    expect(r.errors.some(e => /already declared/i.test(e.message))).toBe(true)
  })

  test('passes when all servers are unique and valid', () => {
    const r = validateMcpServers([
      httpServer({ id: 'a', tools: [tool({ name: 'tool_a' })] }),
      httpServer({ id: 'b', tools: [tool({ name: 'tool_b' })] }),
    ])
    expect(r.valid.length).toBe(2)
    expect(r.errors.length).toBe(0)
  })

  test('individual schema failures surface in errors', () => {
    const r = validateMcpServers([
      { id: 'broken', transport: 'stdio' },  // missing command
    ])
    expect(r.valid.length).toBe(0)
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.errors[0].serverId).toBe('broken')
  })
})

describe('schema parity with pydantic (regression sentinels)', () => {
  // These tests act as canaries. If pydantic and zod drift, the agent will
  // accept a server that the webapp rejects (or vice versa) — a UX bug.
  test('streamable_http id pattern matches the pydantic ID_RE', () => {
    // Same regex as agentic/mcp_registry.py: /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/
    expect(mcpServerSchema.safeParse(httpServer({ id: '_underscore_start' })).success).toBe(true)
    expect(mcpServerSchema.safeParse(httpServer({ id: '1leading-digit' })).success).toBe(true)
    expect(mcpServerSchema.safeParse(httpServer({ id: '-leading-hyphen' })).success).toBe(false)
  })

  test('a server with all four required tool fields filled passes', () => {
    const srv: MCPServer = mcpServerSchema.parse(httpServer({
      tools: [tool({ name: 'pure' })],
    }))
    expect(srv.tools[0].purpose).toBe('Does the thing')
  })
})


// REGRESSION: graph_summary and graph_schema ship on BOTH surfaces - the
// agent's own tool list and the inbound MCP server - from one definition, yet
// neither was reserved. A user registering an outbound MCP plugin could
// therefore declare a tool called `graph_summary` and shadow the built-in one,
// so the agent's "what does this project contain" answer came from a
// third-party server instead of the graph.
describe('REGRESSION: the shared graph tools are reserved', () => {
  test('a plugin cannot shadow a built-in graph tool', () => {
    for (const name of ['query_graph', 'graph_summary', 'graph_schema']) {
      expect(BUILTIN_RESERVED_TOOL_NAMES.has(name), `${name} is not reserved`).toBe(true)
    }
  })
})

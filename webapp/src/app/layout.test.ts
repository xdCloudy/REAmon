import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Issue #175 regression: the browser -> agent WebSocket routing hint
 * (window.__REAMON_WS__) must be resolved from process.env at REQUEST time.
 *
 * Every page under the root layout is a 'use client' shell with no server data,
 * so without `dynamic = 'force-dynamic'` Next prerenders them into static
 * .next/server/app/*.html during `next build` - where AGENT_WS_MODE is unset
 * (webapp/Dockerfile passes no such build ARG). The hint then never reaches any
 * browser in a production image: buildAgentWsUrl falls back to same-origin, so
 * every non-localhost browser dials ws://<host>:3000, which runs no WebSocket
 * server, and the agent container logs nothing at all.
 *
 * This is asserted against the SOURCE rather than by importing the layout,
 * because a route segment config is a build-time contract with Next, not
 * runtime behaviour we can exercise here. agentWsUrl.test.ts covers the pure
 * resolveWsHint / buildAgentWsUrl mapping; this covers the wiring that decides
 * whether that mapping ever runs with the real env.
 */

const SRC = readFileSync(path.resolve(__dirname, 'layout.tsx'), 'utf8')

describe('root layout -- request-time rendering (issue #175)', () => {
  test('forces dynamic rendering so process.env is read per request', () => {
    expect(SRC).toMatch(/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/)
  })

  test('still injects the WS routing hint resolved from process.env', () => {
    expect(SRC).toContain('resolveWsHint(process.env)')
    expect(SRC).toContain('window.__REAMON_WS__=')
  })
})

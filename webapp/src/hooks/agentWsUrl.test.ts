import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildAgentWsUrl, resolveWsHint } from './agentWsUrl'

/**
 * Regression suite for the browser -> agent WebSocket URL builder. This exercises
 * the REAL shipped function (not a re-implementation), so a future edit that
 * reintroduces the hardcoded public `:8090` -- the exact bug behind the
 * "Connecting to kali-sandbox..." forever report -- fails here.
 *
 * The four WS hooks (chat /ws/agent, kali terminal, both cypherfix sockets) all
 * delegate to buildAgentWsUrl, so covering it covers all four.
 */

const ENV_KEY = 'NEXT_PUBLIC_AGENT_WS_URL'

// Point buildAgentWsUrl at a synthetic browser location. Uses vi.stubGlobal so
// each case is isolated and restored by vi.unstubAllGlobals() in afterEach.
function stubLocation(loc: { protocol: string; hostname: string; port: string }) {
  vi.stubGlobal('window', { location: loc })
}

beforeEach(() => {
  delete process.env[ENV_KEY]
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env[ENV_KEY]
})

const PATHS = [
  '/ws/agent',
  '/ws/kali-terminal',
  '/ws/cypherfix-triage',
  '/ws/cypherfix-codefix',
] as const

describe('buildAgentWsUrl -- NEXT_PUBLIC_AGENT_WS_URL baked (deploy.sh single-origin)', () => {
  test('swaps the /ws/agent suffix for the caller path (wss domain)', () => {
    process.env[ENV_KEY] = 'wss://redamon.example.com/ws/agent'
    expect(buildAgentWsUrl('/ws/kali-terminal')).toBe('wss://redamon.example.com/ws/kali-terminal')
    expect(buildAgentWsUrl('/ws/cypherfix-triage')).toBe('wss://redamon.example.com/ws/cypherfix-triage')
    expect(buildAgentWsUrl('/ws/cypherfix-codefix')).toBe('wss://redamon.example.com/ws/cypherfix-codefix')
  })

  test('/ws/agent path is a no-op replace, returns the configured URL verbatim', () => {
    process.env[ENV_KEY] = 'wss://redamon.example.com/ws/agent'
    expect(buildAgentWsUrl('/ws/agent')).toBe('wss://redamon.example.com/ws/agent')
  })

  test('honours ws:// (http-mode deploy)', () => {
    process.env[ENV_KEY] = 'ws://redamon.example.com/ws/agent'
    expect(buildAgentWsUrl('/ws/kali-terminal')).toBe('ws://redamon.example.com/ws/kali-terminal')
  })

  test('the env branch never injects a :8090 port', () => {
    process.env[ENV_KEY] = 'wss://redamon.example.com/ws/agent'
    for (const p of PATHS) {
      expect(buildAgentWsUrl(p)).not.toContain(':8090')
    }
  })

  test('env branch wins even when a window is present', () => {
    process.env[ENV_KEY] = 'wss://redamon.example.com/ws/agent'
    stubLocation({ protocol: 'https:', hostname: 'someotherhost', port: '' })
    expect(buildAgentWsUrl('/ws/kali-terminal')).toBe('wss://redamon.example.com/ws/kali-terminal')
  })
})

describe('buildAgentWsUrl -- browser auto-detect, local dev keeps :8090', () => {
  test('localhost targets the agent on :8090 (ws)', () => {
    stubLocation({ protocol: 'http:', hostname: 'localhost', port: '3000' })
    expect(buildAgentWsUrl('/ws/agent')).toBe('ws://localhost:8090/ws/agent')
    expect(buildAgentWsUrl('/ws/kali-terminal')).toBe('ws://localhost:8090/ws/kali-terminal')
  })

  test('127.0.0.1 targets the agent on :8090', () => {
    stubLocation({ protocol: 'http:', hostname: '127.0.0.1', port: '3000' })
    expect(buildAgentWsUrl('/ws/cypherfix-triage')).toBe('ws://127.0.0.1:8090/ws/cypherfix-triage')
  })
})

describe('buildAgentWsUrl -- browser auto-detect, proxied deploy uses same origin (the fix)', () => {
  test('custom domain over https -> wss same-origin, NO :8090', () => {
    stubLocation({ protocol: 'https:', hostname: 'redamon.example.com', port: '' })
    const url = buildAgentWsUrl('/ws/kali-terminal')
    expect(url).toBe('wss://redamon.example.com/ws/kali-terminal')
    expect(url).not.toContain(':8090')
  })

  test('custom domain over http -> ws same-origin, NO :8090', () => {
    stubLocation({ protocol: 'http:', hostname: 'redamon.example.com', port: '' })
    const url = buildAgentWsUrl('/ws/agent')
    expect(url).toBe('ws://redamon.example.com/ws/agent')
    expect(url).not.toContain(':8090')
  })

  test('non-default proxy port is preserved (e.g. :8443)', () => {
    stubLocation({ protocol: 'https:', hostname: 'redamon.example.com', port: '8443' })
    expect(buildAgentWsUrl('/ws/cypherfix-codefix')).toBe(
      'wss://redamon.example.com:8443/ws/cypherfix-codefix',
    )
  })

  test('bare public IP host reuses the origin, not :8090', () => {
    stubLocation({ protocol: 'https:', hostname: '203.0.113.7', port: '' })
    const url = buildAgentWsUrl('/ws/agent')
    expect(url).toBe('wss://203.0.113.7/ws/agent')
    expect(url).not.toContain(':8090')
  })

  test('no WS path across the four sockets leaks :8090 on a proxied host', () => {
    stubLocation({ protocol: 'https:', hostname: 'redamon.example.com', port: '' })
    for (const p of PATHS) {
      expect(buildAgentWsUrl(p)).not.toContain(':8090')
    }
  })
})

describe('buildAgentWsUrl -- runtime routing hint (issue #159: no-reverse-proxy deploy)', () => {
  function stubWindow(loc: { protocol: string; hostname: string; port: string }, hint: unknown) {
    vi.stubGlobal('window', { location: loc, __REAMON_WS__: hint })
  }

  test('agent-port hint over a LAN IP dials the agent port on the browser host (THE FIX)', () => {
    stubWindow({ protocol: 'http:', hostname: '192.168.1.157', port: '3000' }, { port: '8090' })
    expect(buildAgentWsUrl('/ws/kali-terminal')).toBe('ws://192.168.1.157:8090/ws/kali-terminal')
    expect(buildAgentWsUrl('/ws/agent')).toBe('ws://192.168.1.157:8090/ws/agent')
  })

  test('agent-port hint on localhost still uses :8090', () => {
    stubWindow({ protocol: 'http:', hostname: 'localhost', port: '3000' }, { port: '8090' })
    expect(buildAgentWsUrl('/ws/agent')).toBe('ws://localhost:8090/ws/agent')
  })

  test('agent-port hint over https -> wss on that port', () => {
    stubWindow({ protocol: 'https:', hostname: 'box.lan', port: '3000' }, { port: '8090' })
    expect(buildAgentWsUrl('/ws/agent')).toBe('wss://box.lan:8090/ws/agent')
  })

  test('a custom agent port is honoured', () => {
    stubWindow({ protocol: 'http:', hostname: '10.0.0.5', port: '3000' }, { port: '9000' })
    expect(buildAgentWsUrl('/ws/agent')).toBe('ws://10.0.0.5:9000/ws/agent')
  })

  test('full-URL hint swaps the /ws/agent suffix', () => {
    stubWindow({ protocol: 'http:', hostname: '10.0.0.5', port: '3000' }, { url: 'wss://redamon.lan/ws/agent' })
    expect(buildAgentWsUrl('/ws/kali-terminal')).toBe('wss://redamon.lan/ws/kali-terminal')
  })

  test('NEXT_PUBLIC_AGENT_WS_URL still wins over the runtime hint (single-host untouched)', () => {
    process.env[ENV_KEY] = 'wss://prod.example.com/ws/agent'
    stubWindow({ protocol: 'https:', hostname: 'prod.example.com', port: '' }, { port: '8090' })
    expect(buildAgentWsUrl('/ws/agent')).toBe('wss://prod.example.com/ws/agent')
  })

  test('NO hint -> same-origin behavior preserved, incl. a proxy on a non-standard port', () => {
    // Proxied deploys don't set the hint (or they set NEXT_PUBLIC_*). Must stay
    // same-origin so nginx on :8443 keeps routing /ws/* — the case the port
    // heuristic would have broken.
    stubWindow({ protocol: 'https:', hostname: 'redamon.example.com', port: '8443' }, undefined)
    expect(buildAgentWsUrl('/ws/agent')).toBe('wss://redamon.example.com:8443/ws/agent')
    expect(buildAgentWsUrl('/ws/agent')).not.toContain(':8090')
  })
})

describe('buildAgentWsUrl -- base URL without the /ws/agent suffix (robustness)', () => {
  test('NEXT_PUBLIC base without /ws/agent still appends the path (never drops it)', () => {
    process.env[ENV_KEY] = 'wss://redamon.example.com'
    expect(buildAgentWsUrl('/ws/kali-terminal')).toBe('wss://redamon.example.com/ws/kali-terminal')
    expect(buildAgentWsUrl('/ws/agent')).toBe('wss://redamon.example.com/ws/agent')
  })

  test('trailing slash on the base is not doubled', () => {
    process.env[ENV_KEY] = 'wss://redamon.example.com/'
    expect(buildAgentWsUrl('/ws/agent')).toBe('wss://redamon.example.com/ws/agent')
  })

  test('runtime url hint WITHOUT the suffix appends the path (AGENT_WS_PUBLIC_URL footgun)', () => {
    vi.stubGlobal('window', {
      location: { protocol: 'http:', hostname: '10.0.0.5', port: '3000' },
      __REAMON_WS__: { url: 'ws://10.0.0.5:8090' },
    })
    expect(buildAgentWsUrl('/ws/kali-terminal')).toBe('ws://10.0.0.5:8090/ws/kali-terminal')
    expect(buildAgentWsUrl('/ws/agent')).toBe('ws://10.0.0.5:8090/ws/agent')
  })

  test('empty hint object falls back to same-origin (no crash, no :8090 leak)', () => {
    vi.stubGlobal('window', {
      location: { protocol: 'https:', hostname: 'redamon.example.com', port: '' },
      __REAMON_WS__: {},
    })
    const url = buildAgentWsUrl('/ws/agent')
    expect(url).toBe('wss://redamon.example.com/ws/agent')
    expect(url).not.toContain(':8090')
  })
})

describe('resolveWsHint -- server env -> injected hint (app/layout.tsx mapping)', () => {
  test('AGENT_WS_PUBLIC_URL wins and yields a url hint', () => {
    expect(resolveWsHint({ AGENT_WS_PUBLIC_URL: 'wss://x/ws/agent', AGENT_WS_MODE: 'agent-port', AGENT_WS_PORT: '8090' }))
      .toEqual({ url: 'wss://x/ws/agent' })
  })

  test('agent-port mode yields a port hint (default 8090)', () => {
    expect(resolveWsHint({ AGENT_WS_MODE: 'agent-port' })).toEqual({ port: '8090' })
  })

  test('agent-port mode honours a custom AGENT_WS_PORT', () => {
    expect(resolveWsHint({ AGENT_WS_MODE: 'agent-port', AGENT_WS_PORT: '9000' })).toEqual({ port: '9000' })
  })

  test('no relevant env -> null (browser keeps same-origin behavior)', () => {
    expect(resolveWsHint({})).toBeNull()
  })

  test('a non-agent-port mode (e.g. same-origin) -> null', () => {
    expect(resolveWsHint({ AGENT_WS_MODE: 'same-origin' })).toBeNull()
  })

  test('empty AGENT_WS_PUBLIC_URL is ignored (falls through to mode)', () => {
    expect(resolveWsHint({ AGENT_WS_PUBLIC_URL: '', AGENT_WS_MODE: 'agent-port' })).toEqual({ port: '8090' })
  })
})

describe('buildAgentWsUrl -- SSR fallback (no window)', () => {
  test('returns dev localhost:8090 when window is undefined', () => {
    vi.stubGlobal('window', undefined)
    expect(buildAgentWsUrl('/ws/agent')).toBe('ws://localhost:8090/ws/agent')
  })
})

describe('buildAgentWsUrl -- ticket query param (STRIDE S3/S4)', () => {
  test('appends ticket with ? on a portless proxied URL', () => {
    stubLocation({ protocol: 'https:', hostname: 'redamon.example.com', port: '' })
    expect(buildAgentWsUrl('/ws/kali-terminal', 'abc.def.ghi')).toBe(
      'wss://redamon.example.com/ws/kali-terminal?ticket=abc.def.ghi',
    )
  })

  test('URL-encodes ticket values that contain reserved chars', () => {
    process.env[ENV_KEY] = 'wss://redamon.example.com/ws/agent'
    const url = buildAgentWsUrl('/ws/cypherfix-triage', 'a b+c/d=e')
    expect(url).toBe('wss://redamon.example.com/ws/cypherfix-triage?ticket=a%20b%2Bc%2Fd%3De')
  })

  test('no ticket -> no query string', () => {
    stubLocation({ protocol: 'http:', hostname: 'localhost', port: '3000' })
    expect(buildAgentWsUrl('/ws/agent')).not.toContain('ticket=')
  })

  test('empty-string ticket is treated as absent (falsy)', () => {
    stubLocation({ protocol: 'http:', hostname: 'localhost', port: '3000' })
    expect(buildAgentWsUrl('/ws/agent', '')).toBe('ws://localhost:8090/ws/agent')
  })
})

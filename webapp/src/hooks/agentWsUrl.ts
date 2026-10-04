/**
 * Single source of truth for every browser -> agent WebSocket URL: the chat
 * socket (`/ws/agent`), the Kali terminal, and both cypherfix sockets. Keeping
 * one implementation means one code path to reason about and to test.
 *
 * Resolution order:
 *
 *  1. `NEXT_PUBLIC_AGENT_WS_URL` -- baked at build time by the single-origin
 *     deploy (deploy.sh computes `wss://<host>/ws/agent`). The value always ends
 *     in `/ws/agent`; we swap that suffix for the caller's path.
 *
 *  2. Browser auto-detect (no env var -- local dev, or a build where the ARG was
 *     not passed). `localhost`/`127.0.0.1` talk straight to the agent on `:8090`
 *     (the dev topology: UI on :3000, agent on :8090). ANY other host reuses the
 *     current page origin (`host[:port]`) so whatever reverse proxy served the
 *     page (nginx on 80/443) also routes `/ws/*`. We deliberately do NOT hardcode
 *     a public `:8090` here: in a hardened deploy the agent port is loopback-bound
 *     and unreachable from the browser, so a `:8090` fallback could only ever fail.
 *
 *  3. SSR fallback (no `window`) -- dev-only `localhost:8090`; never reaches a real
 *     browser (the socket is opened client-side).
 *
 * @param path   WS path to target, e.g. `/ws/kali-terminal`. Should start `/ws/`.
 * @param ticket optional ws-ticket, appended as a `ticket` query param (STRIDE S3/S4).
 */
declare global {
  interface Window {
    /** Server-injected browser->agent WS routing hint (app/layout.tsx). */
    __REAMON_WS__?: { url?: string; port?: string }
  }
}

/**
 * Turn a configured agent BASE URL into the URL for `path`. Canonically the base
 * ends in `/ws/agent` (deploy.sh + docs), so we swap that suffix. But if an operator
 * hand-sets AGENT_WS_PUBLIC_URL without the suffix (e.g. `ws://host:8090` or a
 * trailing slash), a naive suffix-replace would be a no-op and SILENTLY DROP the
 * path - every socket (agent, terminal, cypherfix) would then dial the same wrong
 * URL. So fall back to appending the path in that case.
 */
function applyPath(url: string, path: string): string {
  return /\/ws\/agent$/.test(url)
    ? url.replace(/\/ws\/agent$/, path)
    : url.replace(/\/+$/, '') + path
}

/**
 * Server-side (app/layout.tsx): resolve the browser->agent WS routing hint from env
 * so it can be injected as `window.__REAMON_WS__`. Pure + exported so the mapping
 * is unit-tested independently of React rendering.
 *
 *  - AGENT_WS_PUBLIC_URL (explicit full URL) wins.
 *  - else AGENT_WS_MODE=agent-port -> dial the agent's published port (AGENT_WS_PORT,
 *    default 8090) on the browser's own host. This is the default for the
 *    no-reverse-proxy deploy (issue #159).
 *  - else null -> the browser keeps the same-origin behavior (proxied deploy).
 */
export function resolveWsHint(env: Record<string, string | undefined>): { url: string } | { port: string } | null {
  const url = env.AGENT_WS_PUBLIC_URL || ''
  if (url) return { url }
  if (env.AGENT_WS_MODE === 'agent-port') return { port: env.AGENT_WS_PORT || '8090' }
  return null
}

export function buildAgentWsUrl(path: string, ticket?: string): string {
  let base: string
  const configured = process.env.NEXT_PUBLIC_AGENT_WS_URL
  // Runtime routing hint injected by the server (app/layout.tsx) from the
  // AGENT_WS_PUBLIC_URL / AGENT_WS_MODE env. It lets a deploy WITHOUT a reverse
  // proxy point the browser straight at the agent's published port -- fixing the
  // "Connecting to kali-sandbox…" hang over the LAN (issue #159), where the UI
  // dialed the webapp's own port (e.g. :3000), which runs no WebSocket server.
  // A reverse-proxied deploy leaves this unset and keeps the same-origin path
  // below. The browser can't tell "proxy on an odd port" from "raw webapp port"
  // on its own, so the SERVER declares which one it is.
  const rt = (typeof window !== 'undefined' ? window.__REAMON_WS__ : undefined) || undefined
  if (configured) {
    base = applyPath(configured, path)
  } else if (rt && rt.url) {
    // explicit full URL override (canonically ends in /ws/agent, like NEXT_PUBLIC_*)
    base = applyPath(rt.url, path)
  } else if (rt && rt.port && typeof window !== 'undefined') {
    // no reverse proxy: dial the agent's published port on the browser's own host.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    base = `${protocol}//${window.location.hostname}:${rt.port}${path}`
  } else if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.hostname
    const port = window.location.port
    const isLocal = host === 'localhost' || host === '127.0.0.1'
    const authority = isLocal ? `${host}:8090` : port ? `${host}:${port}` : host
    base = `${protocol}//${authority}${path}`
  } else {
    base = `ws://localhost:8090${path}`
  }
  if (ticket) {
    base += (base.includes('?') ? '&' : '?') + 'ticket=' + encodeURIComponent(ticket)
  }
  return base
}

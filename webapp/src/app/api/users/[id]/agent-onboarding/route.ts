/**
 * Generate an Agent Onboarding pack.
 *
 * Deliberately NOT under `/api/mcp-server`, which is public and bearer-only:
 * this is an operator screen doing operator work, so it is judged on the browser
 * session like every other token route. A bearer token must not be able to ask
 * RedAmon to write documentation for a permission set it does not hold.
 *
 * The generated content depends on `(profile, scopes, serverUrl, style, layout)`
 * ALONE. It is user-scoped only for consistency with the sibling token routes;
 * nothing user-specific, and no project data, reaches the output. That is
 * asserted in onboarding.test.ts, because a SKILL.md gets committed into a
 * repository.
 *
 * This route GRANTS NOTHING. It reads no token and writes no row: the scopes in
 * the body describe a document, not a credential. The modal says so too, or a
 * user would believe ticking a box there had widened their token.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireUserAccess } from '@/lib/session'
import { validateScopes } from '@/lib/mcpAuth'
import { validateProfile } from '@/lib/mcp/profiles'
import { listAdvertisedTools } from '@/lib/mcp/apiReference'
import { renderOnboardingPack, type OnboardingOptions } from '@/lib/mcp/onboarding'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** Long enough for any real deployment hostname, short enough to bound the output. */
const MAX_SERVER_URL = 512

/**
 * Only an absolute http(s) origin, and only its origin part.
 *
 * This string is the one caller-controlled value that reaches the generated
 * file, so anything exotic (a `javascript:` scheme, an embedded newline, a path
 * carrying markdown) is refused rather than escaped. Keeping the origin alone
 * also means a pasted deep link still produces the right endpoint.
 */
function resolveServerUrl(raw: unknown): { serverUrl: string | undefined } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return { serverUrl: undefined }
  if (typeof raw !== 'string' || raw.length > MAX_SERVER_URL) {
    return { error: 'The server URL is not valid.' }
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { error: 'The server URL must be an absolute URL, such as https://redamon.example.' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'The server URL must use http or https.' }
  }
  return { serverUrl: parsed.origin }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const denied = await requireUserAccess(request, id)
  if (denied) return denied

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const scopeResult = validateScopes(body.scopes)
  if ('error' in scopeResult) {
    return NextResponse.json({ error: scopeResult.error }, { status: 400 })
  }
  const profileResult = validateProfile(body.profile)
  if ('error' in profileResult) {
    return NextResponse.json({ error: profileResult.error }, { status: 400 })
  }
  const urlResult = resolveServerUrl(body.serverUrl)
  if ('error' in urlResult) {
    return NextResponse.json({ error: urlResult.error }, { status: 400 })
  }

  const style = body.style === 'http' ? 'http' : 'mcp'
  const layout = body.layout === 'single' ? 'single' : 'folder'
  const opts: OnboardingOptions = {
    serverUrl: urlResult.serverUrl,
    style,
    layout,
    // The same stamp buildMcpServer reports as the server version, so a reader
    // can tell which build a downloaded pack describes.
    version: process.env.NEXT_PUBLIC_REAMON_VERSION || '0.0.0',
  }

  try {
    // Read from the server's own tools/list, exactly like the API reference, so
    // a tool this deployment withdrew is absent from the pack for free.
    const tools = await listAdvertisedTools()
    const pack = renderOnboardingPack(tools, scopeResult.scopes, profileResult.profile, opts)
    return NextResponse.json(
      {
        files: pack.files,
        profile: profileResult.profile,
        scopes: scopeResult.scopes,
        available: pack.available,
        unavailable: pack.unavailable,
      },
      // A document built from a permission set is not something to cache in a
      // shared proxy, and it changes whenever the surface does.
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (error) {
    console.error('[agent-onboarding] generation failed:', error)
    return NextResponse.json({ error: 'Could not generate the onboarding pack' }, { status: 500 })
  }
}

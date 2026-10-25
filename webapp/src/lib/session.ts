import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { verifyToken, verifyActAsToken, AUTH_COOKIE_NAME, ACT_AS_COOKIE_NAME } from './auth'
import { constantTimeEqual } from './constantTimeEqual'

export interface Session {
  userId: string
  role: string
}

/**
 * The user whose data a request is authorized to touch. For a standard user this
 * is always their own id; for an admin it is their own id unless they are
 * actively simulating another user (see getEffectiveUser).
 */
export interface EffectiveUser {
  userId: string
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(AUTH_COOKIE_NAME)?.value
  if (!token) return null
  const payload = await verifyToken(token)
  if (!payload) return null
  return { userId: payload.sub, role: payload.role }
}

/**
 * Resolves the EFFECTIVE user for authorization decisions:
 *   - standard user       -> own id (any `redamon-act-as` cookie is IGNORED)
 *   - admin, not simulating -> own id
 *   - admin, simulating X   -> X, but only when the act-as cookie was minted by
 *                              THIS admin (claims.sub === session.userId)
 * Returns null when there is no valid login session (caller returns 401).
 *
 * The real identity/role always comes from the untouched login JWT (getSession);
 * the act-as cookie can only ever narrow an admin to a single other user, never
 * grant a standard user cross-user access.
 */
export async function getEffectiveUser(): Promise<EffectiveUser | null> {
  const session = await getSession()
  if (!session) return null
  if (session.role !== 'admin') {
    return { userId: session.userId }
  }
  const cookieStore = await cookies()
  const actAsToken = cookieStore.get(ACT_AS_COOKIE_NAME)?.value
  if (actAsToken) {
    const claims = await verifyActAsToken(actAsToken)
    if (claims && claims.sub === session.userId) {
      return { userId: claims.act }
    }
  }
  return { userId: session.userId }
}

/**
 * Returns session or a 401 NextResponse. Caller must check and return the response.
 * Usage: const result = await requireSession(); if (result instanceof NextResponse) return result;
 */
export async function requireSession(): Promise<Session | NextResponse> {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return session
}

/**
 * Returns admin session or a 401/403 NextResponse. Caller must check and return the response.
 * Usage: const result = await requireAdmin(); if (result instanceof NextResponse) return result;
 */
export async function requireAdmin(): Promise<Session | NextResponse> {
  const result = await requireSession()
  if (result instanceof NextResponse) return result
  if (result.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return result
}

export function isInternalRequest(request: NextRequest): boolean {
  const key = request.headers.get('x-internal-key')
  const expected = process.env.INTERNAL_API_KEY
  if (!key || !expected || expected === 'changeme') return false
  // A duplicated scanner secret must never inherit master-key privileges.
  const scanner = process.env.SCANNER_API_KEY
  if (scanner && scanner !== 'changeme' && constantTimeEqual(expected, scanner)) return false
  return constantTimeEqual(key, expected)
}

/**
 * Lower-tier scanner principal. Route handlers must combine this transport
 * identity with getScannerScope() before returning or writing tenant data. The
 * middleware also restricts the key to its small route/method allowlist.
 */
export function isScannerRequest(request: NextRequest): boolean {
  const key = request.headers.get('x-internal-key')
  const expected = process.env.SCANNER_API_KEY
  if (!key || !expected || expected === 'changeme') return false
  const master = process.env.INTERNAL_API_KEY
  if (master && master !== 'changeme' && constantTimeEqual(expected, master)) return false
  return constantTimeEqual(key, expected)
}

export interface ScannerScope {
  projectId: string
  userId: string
}

/** Verify the orchestrator-signed tenant scope carried by each scan container. */
export function getScannerScope(request: NextRequest): ScannerScope | null {
  const token = request.headers.get('x-scanner-scope') || ''
  const secret = process.env.INTERNAL_API_KEY
  if (!token || token.length > 2048 || !secret || secret === 'changeme') return null

  const [encoded, signature, extra] = token.split('.')
  if (!encoded || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encoded)
      || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null

  try {
    const expected = createHmac('sha256', secret).update(encoded).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || actual.toString('base64url') !== signature
        || !timingSafeEqual(actual, expected)) return null

    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      v?: unknown; projectId?: unknown; userId?: unknown; iat?: unknown; exp?: unknown
    }
    const now = Math.floor(Date.now() / 1000)
    if (payload.v !== 1 || typeof payload.projectId !== 'string' || !payload.projectId
        || payload.projectId.length > 255 || typeof payload.userId !== 'string' || !payload.userId
        || payload.userId.length > 255 || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)
        || (payload.iat as number) > now + 60 || (payload.exp as number) <= now
        || (payload.exp as number) - (payload.iat as number) > 7 * 24 * 60 * 60) return null
    return { projectId: payload.projectId, userId: payload.userId }
  } catch {
    return null
  }
}

/**
 * Ownership gate for user-scoped secret/data routes (settings, llm-providers,
 * tradecraft). Internal-key callers (the agent + scanners) pass through; every
 * other caller must have a session and either own `targetUserId` or be an admin.
 *
 * Enforcement is IMMEDIATE (not the log-only ACCESS_ENFORCE path) because these
 * routes expose or mutate a user's plaintext secrets - this is the closure of
 * STRIDE I1 for the single-item routes the list-route fix missed. Returns null
 * when allowed, or a 401/403 NextResponse the caller must return.
 *
 * Note: the admin bypass here is a masked-read/write convenience preserved from
 * the shipped I1 model; the stricter effective-user scoping of admins (admin sees
 * a user's data only while explicitly simulating them) is applied to the data
 * routes in the BOLA rollout and may later subsume this bypass.
 */
export async function requireUserAccess(
  request: NextRequest,
  targetUserId: string
): Promise<NextResponse | null> {
  if (isInternalRequest(request)) return null
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (session.userId !== targetUserId && session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

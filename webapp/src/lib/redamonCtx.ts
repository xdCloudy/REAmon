import { createHmac } from 'crypto'
import { timingSafeEqual } from 'crypto'

/**
 * TypeScript minter for the X-Redamon-Ctx capture tag.
 *
 * Byte-for-byte compatible with `redamon_ctx.py` (verified by the ingest worker):
 * canonical JSON = only the allowlisted fields, nulls dropped, keys sorted,
 * compact separators; token = base64url(json).base64url(hmac_sha256), no '='.
 *
 * Used to mint the `operator` recording tag with INTERNAL_API_KEY. The webapp is
 * the ONLY TS minter; recon/agent mint in Python with their own keys.
 */

// Must match _ALLOWED_FIELDS in redamon_ctx.py exactly (order irrelevant; sorted below).
const ALLOWED_FIELDS = [
  'source', 'project_id', 'user_id', 'run_id', 'session_id',
  'tool', 'phase', 'step', 'member_id', 'is_replay', 'origin_id',
  'exp',
] as const

export type CtxPayload = Partial<Record<(typeof ALLOWED_FIELDS)[number], string | boolean | number>>

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function canonical(payload: CtxPayload): string {
  const filtered: Record<string, string | boolean | number> = {}
  for (const k of [...ALLOWED_FIELDS].sort()) {
    const v = payload[k]
    if (v !== undefined && v !== null) filtered[k] = v
  }
  // JSON.stringify with no spaces matches Python separators (',',':'); our values
  // are ASCII ids so ensure_ascii vs not is moot.
  return JSON.stringify(filtered)
}

/** Verify Python/TypeScript context tags using the same canonical payload bytes. */
export function verifyTag(token: string, key: string): CtxPayload | null {
  if (!token || token.length > 2048 || !key) return null
  const [encoded, signature, extra] = token.split('.')
  if (!encoded || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encoded)
      || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null
  try {
    const raw = Buffer.from(encoded, 'base64url')
    if (raw.toString('base64url') !== encoded) return null
    const expected = createHmac('sha256', key).update(raw).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || actual.toString('base64url') !== signature
        || !timingSafeEqual(actual, expected)) return null
    const payload = JSON.parse(raw.toString('utf8')) as CtxPayload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || canonical(payload) !== raw.toString('utf8')) return null
    return payload
  } catch {
    return null
  }
}

export function signTag(payload: CtxPayload, key: string): string {
  if (!key) throw new Error('empty signing key')
  const raw = Buffer.from(canonical(payload), 'utf-8')
  const sig = createHmac('sha256', key).update(raw).digest()
  return `${b64url(raw)}.${b64url(sig)}`
}

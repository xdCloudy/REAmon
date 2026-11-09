import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_PREVIOUS_CURSOR_KEYS = 3

function signingKeys(): string[] | null {
  const active = process.env.INTERNAL_API_KEY
  if (!active || active === 'changeme') return null

  const previousSetting = process.env.WORKSPACE_CURSOR_PREVIOUS_KEYS
  const previous = previousSetting ? previousSetting.split(',').map((key) => key.trim()) : []
  if (previous.length > MAX_PREVIOUS_CURSOR_KEYS || previous.some((key) => !key || key === 'changeme')) return null

  return [...new Set([active, ...previous])]
}

export function signWorkspaceCursorPayload(payload: string): string | null {
  const keys = signingKeys()
  if (!keys) return null
  return createHmac('sha256', keys[0]).update(payload).digest('base64url')
}

export function verifyWorkspaceCursorPayload(payload: string, suppliedSignature: string): boolean | null {
  const keys = signingKeys()
  if (!keys) return null

  const supplied = Buffer.from(suppliedSignature, 'base64url')
  let valid = false
  for (const key of keys) {
    const expected = createHmac('sha256', key).update(payload).digest()
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) valid = true
  }
  return valid
}

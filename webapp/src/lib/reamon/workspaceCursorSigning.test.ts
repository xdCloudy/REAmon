/** @vitest-environment node */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { signWorkspaceCursorPayload, verifyWorkspaceCursorPayload } from './workspaceCursorSigning'

describe('workspace cursor key rotation', () => {
  afterEach(() => vi.unstubAllEnvs())

  test('verifies active and bounded prior keys while signing only with the active key', () => {
    vi.stubEnv('INTERNAL_API_KEY', 'previous-workspace-cursor-key')
    const oldSignature = signWorkspaceCursorPayload('cursor-payload')
    expect(oldSignature).toEqual(expect.any(String))

    vi.stubEnv('INTERNAL_API_KEY', 'active-workspace-cursor-key')
    vi.stubEnv('WORKSPACE_CURSOR_PREVIOUS_KEYS', ' previous-workspace-cursor-key,retired-workspace-cursor-key ')
    expect(verifyWorkspaceCursorPayload('cursor-payload', oldSignature!)).toBe(true)

    const activeSignature = signWorkspaceCursorPayload('cursor-payload')
    expect(activeSignature).not.toBe(oldSignature)
    expect(verifyWorkspaceCursorPayload('cursor-payload', activeSignature!)).toBe(true)
    vi.stubEnv('WORKSPACE_CURSOR_PREVIOUS_KEYS', '')
    expect(verifyWorkspaceCursorPayload('cursor-payload', oldSignature!)).toBe(false)
  })

  test('fails closed for malformed or oversized previous-key configuration', () => {
    vi.stubEnv('INTERNAL_API_KEY', 'active-workspace-cursor-key')
    vi.stubEnv('WORKSPACE_CURSOR_PREVIOUS_KEYS', 'one,two,three,four')
    expect(signWorkspaceCursorPayload('cursor-payload')).toBeNull()
    expect(verifyWorkspaceCursorPayload('cursor-payload', 'invalid')).toBeNull()

    vi.stubEnv('WORKSPACE_CURSOR_PREVIOUS_KEYS', 'one,,three')
    expect(signWorkspaceCursorPayload('cursor-payload')).toBeNull()
  })
})

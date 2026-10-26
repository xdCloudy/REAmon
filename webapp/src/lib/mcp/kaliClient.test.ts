/**
 * The MCP server's Kali transport.
 *
 * @vitest-environment node
 */
import { describe, test, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('@/lib/agentFetch', () => ({ agentBaseUrl: () => 'http://agent:8080' }))
vi.mock('@/lib/agentAuth', () => ({ internalKeyHeaders: (x?: object) => ({ ...(x ?? {}) }) }))

import { kaliExec, kaliJobCancel, kaliJobStatus } from './kaliClient'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubGlobal('fetch', h.fetch)
})

describe('an agent 4xx reaches the caller', () => {
  // A sibling session found this class in graphClient.ts: a refusal the caller
  // could have acted on was collapsed into a flat generic message. The same
  // shape was here - the agent answers 409 from kali_cancel with the reason a
  // job could not be stopped, and only 400/404/429/503 were enumerated.
  const agentSays = (status: number, error: string) => {
    h.fetch.mockResolvedValue({
      ok: false, status,
      json: async () => ({ error }),
    })
  }

  test('a 409 conflict carries its reason instead of a generic message', async () => {
    agentSays(409, 'the job already finished and cannot be cancelled')
    await expect(kaliJobCancel('p1', 'a'.repeat(32)))
      .rejects.toThrow(/already finished and cannot be cancelled/)
  })

  test('an unenumerated 4xx carries its reason too', async () => {
    agentSays(422, 'cursor must be a whole number of bytes')
    await expect(kaliJobStatus('p1', 'a'.repeat(32), 0))
      .rejects.toThrow(/whole number of bytes/)
  })

  test('a 5xx still degrades to a fixed line', async () => {
    // Those bodies are raw exception text: host paths and image names.
    agentSays(500, "FileNotFoundError: /opt/redamon/agentic/api.py line 42")
    await expect(kaliJobStatus('p1', 'a'.repeat(32), 0))
      .rejects.toThrow(/The command could not be run\./)
    await expect(kaliJobStatus('p1', 'a'.repeat(32), 0))
      .rejects.not.toThrow(/api\.py/)
  })

  test('404 stays deliberately uniform, for anti-enumeration', async () => {
    // A missing job and another project's job must read identically.
    agentSays(404, 'no such command')
    await expect(kaliJobStatus('p1', 'a'.repeat(32), 0))
      .rejects.toThrow(/^No such command\.$/)
  })
})

describe('execution identity propagation', () => {
  test('sends the authenticated user and project to the agent', async () => {
    h.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ job_id: 'j1', status: 'done', exit_code: 0, output: 'ok' }),
    })

    await kaliExec('owner-1', 'project-1', 'sleep 1', 0)

    const [url, init] = h.fetch.mock.calls[0]
    expect(url).toBe('http://agent:8080/kali/exec')
    expect(JSON.parse(String(init.body))).toMatchObject({
      user_id: 'owner-1',
      project_id: 'project-1',
      command: 'sleep 1',
      wait_seconds: 0,
    })
  })
})

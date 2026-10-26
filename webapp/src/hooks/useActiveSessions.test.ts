/** @vitest-environment jsdom */
import { afterEach, expect, test, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useActiveSessions } from './useActiveSessions'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('loads sessions for the selected project and clears prior project data on switch', async () => {
  const fetchMock = vi.fn(async () => Response.json({
    sessions: [{
      id: 1,
      type: 'shell',
      info: 'owned session',
      connection: '',
      target_ip: '',
      chat_session_id: 'chat-1',
      project_id: 'p1',
    }],
    jobs: [],
    non_msf_sessions: [],
    agent_busy: false,
  }))
  vi.stubGlobal('fetch', fetchMock)

  const { result, rerender, unmount } = renderHook(
    ({ projectId }: { projectId: string }) => useActiveSessions({ projectId }),
    { initialProps: { projectId: 'p1' } },
  )

  await waitFor(() => expect(result.current.sessions).toHaveLength(1))
  expect(fetchMock).toHaveBeenCalledWith('/api/agent/sessions?projectId=p1', { cache: 'no-store' })

  rerender({ projectId: 'p2' })
  expect(result.current.sessions).toEqual([])

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/api/agent/sessions?projectId=p2',
    { cache: 'no-store' },
  ))
  unmount()
})

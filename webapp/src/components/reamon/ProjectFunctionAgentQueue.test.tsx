/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CodeUnit } from '@/lib/reamon/code-units'
import { ProjectFunctionAgentQueue } from './ProjectFunctionAgentQueue'

function response(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

function renderQueue() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectFunctionAgentQueue projectId="project-1" taskId="task-1" providerId="provider-1" reviewerProviderId="" />
    </QueryClientProvider>,
  )
}

describe('ProjectFunctionAgentQueue', () => {
  beforeEach(() => sessionStorage.clear())
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  test('keeps unqueued functions and advances through later run pages', async () => {
    const visualizerCursors: Array<string | null> = []
    const queuedMembers: string[] = []
    let checkpointRevision = 0
    let checkpointState: unknown = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith('/deobfuscate/scan-state')) {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body || '{}')) as { state: unknown; expectedRevision: number }
          if (body.expectedRevision !== checkpointRevision) return response({ error: 'This scan checkpoint changed in another browser.' }, 409)
          checkpointState = body.state
          checkpointRevision += 1
          return response({ revision: checkpointRevision })
        }
        return response({ state: checkpointState, revision: checkpointRevision })
      }
      if (url.pathname.endsWith('/deobfuscate/batches')) return response({ batch: null })
      if (url.pathname.endsWith('/visualizer')) {
        const cursor = url.searchParams.get('cursor')
        visualizerCursors.push(cursor)
        const pageIndex = cursor ? Number(cursor.slice(1)) : 0
        const unit = {
          id: `unit-${pageIndex}`,
          codeArtifactId: `project-1/artifact-1/task-1/source-${pageIndex}.java`,
          artifactId: 'artifact-1', language: 'Java', unitType: 'source', maintainedSource: false,
          draftSource: false, sizeBytes: 100, name: `Unit${pageIndex}`,
        } as unknown as CodeUnit
        return response({ units: [unit], nextCursor: pageIndex < 4 ? `c${pageIndex + 1}` : null, hasMore: pageIndex < 4 })
      }
      if (url.pathname.endsWith('/visualizer/deobfuscate')) {
        const body = JSON.parse(String(init?.body || '{}')) as { scope?: string; memberName?: string }
        if (body.scope === 'outline') {
          const unitId = (JSON.parse(String(init?.body || '{}')) as { unitId: string }).unitId
          const pageIndex = Number(unitId.slice('unit-'.length))
          const count = pageIndex === 0 ? 12 : pageIndex < 4 ? 3 : 1
          return response({ members: Array.from({ length: count }, (_, index) => ({
            name: `member-${pageIndex}-${index}`, kind: 'method', start_byte: index * 100,
            end_byte: index * 100 + 50, line: index + 1, source_bytes: 50,
          })) })
        }
        queuedMembers.push(body.memberName || '')
        return response({ attemptId: `attempt-${queuedMembers.length}`, status: 'QUEUED' }, 202)
      }
      throw new Error(`Unexpected request ${url.pathname}`)
    }))

    const firstRender = renderQueue()
    const button = await screen.findByRole('button', { name: 'Scan next project batch' })
    await waitFor(() => expect(button).toBeEnabled())

    fireEvent.click(button)
    await waitFor(() => expect(queuedMembers).toHaveLength(10))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Queue remaining functions' })).toBeEnabled())
    expect(screen.getByRole('status')).toHaveTextContent('9 more functions remain in this segment')
    expect(visualizerCursors).toEqual([null, 'c1', 'c2', 'c3'])

    firstRender.unmount()
    renderQueue()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Queue remaining functions' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Queue remaining functions' }))
    await waitFor(() => expect(queuedMembers).toHaveLength(19))
    expect(visualizerCursors).toHaveLength(4)

    fireEvent.click(screen.getByRole('button', { name: 'Continue current scan' }))
    await waitFor(() => expect(queuedMembers).toHaveLength(21))
    expect(visualizerCursors).toHaveLength(4)

    fireEvent.click(screen.getByRole('button', { name: 'Continue current scan' }))
    await waitFor(() => expect(queuedMembers).toHaveLength(22))
    expect(visualizerCursors.at(-1)).toBe('c4')
    expect(new Set(queuedMembers).size).toBe(22)
  })
})

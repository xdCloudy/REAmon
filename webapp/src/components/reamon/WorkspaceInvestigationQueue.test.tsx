/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorkspaceInvestigationQueue } from './WorkspaceInvestigationQueue'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('WorkspaceInvestigationQueue', () => {
  test('loads persisted cases on expand and exposes task status without candidate source', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        investigations: [{
          id: 'case-1', taskId: 'task-1', artifactSha256: 'abcdef0123456789'.repeat(4),
          capability: 'decompile', providerId: 'provider-1', providerVersion: '2.0',
          status: 'QUEUED', attemptCount: 1, hasCandidate: true, active: true,
          task: { title: 'Failed DEX to Java run', status: 'FAILED', capability: 'decompile' },
          attempts: [{ id: 'attempt-1', unitName: 'com.example.Main.run', status: 'RUNNING', candidateAvailable: false, errorCode: null, validationStatus: null, createdAt: '2026-10-29T00:00:00.000Z', completedAt: null }],
        }],
        nextCursor: null,
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}>
      <details id="analysis-tasks"><summary>Tasks</summary>
        <div id="workspace-task-task-1" />
        <WorkspaceInvestigationQueue projectId="project-1" />
      </details>
    </QueryClientProvider>)

    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Investigation queue'))

    await waitFor(() => expect(screen.getByText('Failed DEX to Java run')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/workspace/investigations?limit=25')
    expect(screen.getByText(/com\.example\.Main\.run · running/)).toBeInTheDocument()
    const task = document.getElementById('workspace-task-task-1') as HTMLDivElement
    task.scrollIntoView = vi.fn()
    fireEvent.click(screen.getByRole('button', { name: 'Open task controls' }))
    expect((document.getElementById('analysis-tasks') as HTMLDetailsElement).open).toBe(true)
    await waitFor(() => expect(task.scrollIntoView).toHaveBeenCalled())
  })

  test('reloads an expanded queue after a task action invalidates its query', async () => {
    const emptyPage = { investigations: [], nextCursor: null }
    const updatedPage = {
      investigations: [{
        id: 'case-2', taskId: 'task-2', artifactSha256: '0123456789abcdef'.repeat(4),
        capability: 'decompile', providerId: null, providerVersion: null,
        status: 'QUEUED', attemptCount: 0, hasCandidate: false, active: false,
        task: { title: 'Newly queued DEX run', status: 'FAILED', capability: 'decompile' }, attempts: [],
      }],
      nextCursor: null,
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => emptyPage })
      .mockResolvedValueOnce({ ok: true, json: async () => updatedPage })
    vi.stubGlobal('fetch', fetchMock)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}>
      <WorkspaceInvestigationQueue projectId="project-1" />
    </QueryClientProvider>)

    fireEvent.click(screen.getByText('Investigation queue'))
    await waitFor(() => expect(screen.getByText(/No failed decompile or disassemble runs/)).toBeInTheDocument())
    await queryClient.invalidateQueries({ queryKey: ['reamon-investigations', 'project-1'] })
    await waitFor(() => expect(screen.getByText('Newly queued DEX run')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

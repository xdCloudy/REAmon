/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorkspaceDecompilationAction } from './WorkspaceDecompilationAction'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('WorkspaceDecompilationAction', () => {
  test('creates and executes an explicitly requested decompilation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ task: { id: 'task-1', status: 'QUEUED' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ outcome: 'COMPLETED', task: { id: 'task-1', status: 'COMPLETED' } }) })
    const onChanged = vi.fn()
    const onPendingChange = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<WorkspaceDecompilationAction projectId="project-1" artifactId="artifact-1" providerId="reamon-jadx" onChanged={onChanged} onPendingChange={onPendingChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Run decompilation' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Decompilation run finished.')
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/projects/project-1/workspace/analysis-plan/schedule', expect.objectContaining({
      method: 'POST',
      body: expect.stringMatching(/^\{"artifactId":"artifact-1","providerId":"reamon-jadx","capability":"decompile","approvalRequired":false,"runAttemptId":"[a-f0-9]{32}"\}$/),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/projects/project-1/workspace/tasks/task-1/execute', { method: 'POST' })
    expect(onPendingChange).toHaveBeenNthCalledWith(1, true)
    expect(onPendingChange).toHaveBeenLastCalledWith(false)
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  test('does not execute an existing task that still awaits approval', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ reused: true, task: { id: 'task-1', status: 'AWAITING_APPROVAL' } }),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<WorkspaceDecompilationAction projectId="project-1" artifactId="artifact-1" providerId="reamon-jadx" />)

    fireEvent.click(screen.getByRole('button', { name: 'Run decompilation' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Approval is already pending.')
    expect(screen.getByRole('link', { name: 'Open task controls' })).toHaveAttribute('href', '#analysis-tasks')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('labels the action for a previous task as another decompilation attempt', () => {
    render(<WorkspaceDecompilationAction projectId="project-1" artifactId="artifact-1" providerId="reamon-jadx" hasPreviousRun />)

    expect(screen.getByRole('button', { name: 'Run decompilation again' })).toBeInTheDocument()
  })
})

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkspaceTaskList } from './WorkspaceTaskList'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('WorkspaceTaskList', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ outcome: 'COMPLETED', task: { status: 'COMPLETED' } }),
    }))
  })

  test('runs a queued task and refreshes the workspace after completion', async () => {
    const onExecuted = vi.fn()
    render(<WorkspaceTaskList projectId="project-1" onExecuted={onExecuted} tasks={[{ id: 'task-1', title: 'Inspect source', status: 'QUEUED', progress: 0 }]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Inspect source completed.'))

    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/tasks/task-1/execute', { method: 'POST' })
    expect(onExecuted).toHaveBeenCalledOnce()
  })

  test('does not offer execution for completed tasks', () => {
    render(<WorkspaceTaskList projectId="project-1" tasks={[{ id: 'task-1', title: 'Inspect source', status: 'COMPLETED', progress: 100 }]} />)
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull()
  })
})

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { heartbeatLabel, WorkspaceTaskList } from './WorkspaceTaskList'

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
    const onChanged = vi.fn()
    render(<WorkspaceTaskList projectId="project-1" onChanged={onChanged} tasks={[{ id: 'task-1', title: 'Inspect source', status: 'QUEUED', progress: 0 }]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Inspect source completed.'))

    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/tasks/task-1/execute', { method: 'POST' })
    expect(onChanged).toHaveBeenCalledOnce()
  })

  test('retries a failed task', async () => {
    render(<WorkspaceTaskList projectId="project-1" tasks={[{ id: 'task-1', title: 'Inspect source', status: 'FAILED', progress: 10, error: 'Provider timed out' }]} />)

    expect(screen.getByText('Provider timed out')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Inspect source was requeued.'))

    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/tasks/task-1/retry', { method: 'POST' })
  })

  test('recovers stale tasks from the operator control', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ recovered: 2 }),
    }))
    render(<WorkspaceTaskList projectId="project-1" tasks={[{ id: 'task-1', title: 'Inspect source', status: 'RUNNING', progress: 10 }]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Recover stale' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Recovered 2 stale tasks.'))

    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/tasks/recover', { method: 'POST' })
  })

  test('cancels a running task', async () => {
    render(<WorkspaceTaskList projectId="project-1" tasks={[{ id: 'task-1', title: 'Inspect source', status: 'RUNNING', progress: 10 }]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Inspect source was cancelled.'))

    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/tasks/task-1/cancel', { method: 'POST' })
  })

  test('approves a pending task and refreshes the workspace', async () => {
    const onChanged = vi.fn()
    render(<WorkspaceTaskList projectId="project-1" onChanged={onChanged} tasks={[{ id: 'task-1', title: 'Inspect source', status: 'AWAITING_APPROVAL', progress: 0, approval: { id: 'approval-1', status: 'PENDING' } }]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Inspect source was approved.'))

    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/approvals/approval-1', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    }))
    expect(onChanged).toHaveBeenCalledOnce()
  })

  test('does not offer execution for completed tasks', () => {
    render(<WorkspaceTaskList projectId="project-1" tasks={[{ id: 'task-1', title: 'Inspect source', status: 'COMPLETED', progress: 100 }]} />)
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull()
  })

  test('shows the current lease owner for running tasks', () => {
    render(<WorkspaceTaskList projectId="project-1" tasks={[{ id: 'task-1', title: 'Inspect source', status: 'RUNNING', progress: 35, leaseOwner: 'worker-a', leaseHeartbeatAt: new Date().toISOString() }]} />)

    expect(screen.getByText('RUNNING · progress not reported · worker-a · heartbeat fresh')).toBeInTheDocument()
  })

  test('labels an old heartbeat as stale', () => {
    expect(heartbeatLabel(new Date(Date.now() - 120_000).toISOString())).toBe('heartbeat stale (2m ago)')
    expect(heartbeatLabel(null)).toBe('heartbeat pending')
  })
})

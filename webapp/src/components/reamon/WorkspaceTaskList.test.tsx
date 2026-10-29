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

    fireEvent.click(screen.getByRole('button', { name: 'Run Inspect source' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Inspect source completed.'))

    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/tasks/task-1/execute', { method: 'POST' })
    expect(onChanged).toHaveBeenCalledOnce()
  })

  test('retries a failed task', async () => {
    render(<WorkspaceTaskList projectId="project-1" tasks={[{ id: 'task-1', title: 'Inspect source', status: 'FAILED', progress: 10, error: 'Provider timed out' }]} />)

    expect(screen.getByText('Provider timed out')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry Inspect source' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Inspect source was requeued.'))

    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/tasks/task-1/retry', { method: 'POST' })
  })

  test('queues a failed decompilation for a persisted investigation and disables duplicate requests', async () => {
    const onChanged = vi.fn()
    render(<WorkspaceTaskList projectId="project-1" onChanged={onChanged} tasks={[{ id: 'task-1', title: 'Decompile library', status: 'FAILED', progress: 20, capability: 'decompile' }]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Queue investigation for Decompile library' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Decompile library was queued for investigation.'))

    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/tasks/task-1/investigation', { method: 'POST' })
    expect(onChanged).toHaveBeenCalledOnce()
  })

  test('does not offer agent investigation for non-decompiler failures or duplicate queued cases', () => {
    render(<WorkspaceTaskList projectId="project-1" tasks={[
      { id: 'task-1', title: 'Scan repository', status: 'FAILED', progress: 10, capability: 'security_scan' },
      { id: 'task-2', title: 'Decompile library', status: 'FAILED', progress: 20, capability: 'decompile', investigationCase: { id: 'case-1', status: 'QUEUED' } },
    ]} />)

    expect(screen.queryByRole('button', { name: 'Queue investigation for Scan repository' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Queue investigation for Decompile library' })).toBeDisabled()
  })

  test('requires an explicit saved provider before queueing a reconstruction candidate', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ providers: [{ id: 'provider-1', name: 'Local', modelIdentifier: 'model-a' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ investigation: { id: 'case-1' }, attempts: [], candidateUnits: [{ key: 'fn:1000', label: 'FUN_1000', language: 'c', instructionFields: ['assembly'] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        attempt: { id: 'attempt-1' }, attempts: [{ id: 'attempt-1' }],
        budget: { usedAttempts: 1, maxAttempts: 24, reservedRuntimeMs: 120_000, maxReservedRuntimeMs: 1_800_000 },
      }) })
      .mockResolvedValue({ ok: true, json: async () => ({ investigation: { id: 'case-1' }, attempts: [{ id: 'attempt-1', status: 'RUNNING' }] }) }))
    const onChanged = vi.fn()
    render(<WorkspaceTaskList projectId="project-1" onChanged={onChanged} tasks={[{
      id: 'task-1', title: 'Decompile library', status: 'FAILED', progress: 20, capability: 'decompile',
      investigationCase: { id: 'case-1', status: 'QUEUED' },
    }]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Run investigation for Decompile library' }))
    expect(await screen.findByRole('combobox', { name: 'AI provider for Decompile library' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run investigation for Decompile library' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 reconstruction candidate queued. They remain drafts until reviewed. Case budget: 1/24 attempts; 2/30 minutes reserved.'))
    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/visualizer/providers')
    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/tasks/task-1/investigation?summary=1')
    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/tasks/task-1/investigation/run', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ providerId: 'provider-1', unitKey: 'fn:1000' }),
    }))
    expect(onChanged).toHaveBeenCalledOnce()
  })

  test('offers a bounded all-units investigation batch', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ providers: [{ id: 'provider-1', name: 'Local', modelIdentifier: 'model-a' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ candidateUnits: [
        { key: 'fn:1000', label: 'one', language: 'c', instructionFields: ['assembly'] },
        { key: 'fn:2000', label: 'two', language: 'c', instructionFields: ['assembly'] },
      ], attempts: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ attempts: [{ id: 'attempt-1' }, { id: 'attempt-2' }] }) })
      .mockResolvedValue({ ok: true, json: async () => ({ attempts: [{ id: 'attempt-1', unitName: 'first', status: 'RUNNING' }, { id: 'attempt-2', unitName: 'second', status: 'RUNNING' }] }) }))
    render(<WorkspaceTaskList projectId="project-1" tasks={[{
      id: 'task-1', title: 'Decompile library', status: 'FAILED', progress: 20, capability: 'decompile',
      investigationCase: { id: 'case-1', status: 'QUEUED' },
    }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run investigation for Decompile library' }))
    await screen.findByRole('combobox', { name: 'Code unit for Decompile library' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Code unit for Decompile library' }), { target: { value: '__all__' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run investigation for Decompile library' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/tasks/task-1/investigation/run', expect.objectContaining({
      body: JSON.stringify({ providerId: 'provider-1', unitKeys: ['fn:1000', 'fn:2000'] }),
    })))
    expect(await screen.findByRole('status')).toHaveTextContent('2 reconstruction candidates queued.')
    expect(await screen.findByText('first reconstruction running')).toBeInTheDocument()
    expect(await screen.findByText('second reconstruction running')).toBeInTheDocument()
  })

  test('recovers stale tasks from the operator control', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ recovered: 2 }),
    }))
    render(<WorkspaceTaskList projectId="project-1" tasks={[{ id: 'task-1', title: 'Inspect source', status: 'RUNNING', progress: 10, leaseHeartbeatAt: new Date(Date.now() - 31 * 60_000).toISOString() }]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Requeue stalled task' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Recovered 2 stale tasks.'))

    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/tasks/recover', { method: 'POST' })
  })

  test('does not show recovery controls for a task that is still updating', () => {
    render(<WorkspaceTaskList projectId="project-1" tasks={[{ id: 'task-1', title: 'Inspect source', status: 'RUNNING', progress: 10, leaseHeartbeatAt: new Date().toISOString() }]} />)
    expect(screen.queryByRole('button', { name: 'Requeue stalled task' })).toBeNull()
  })

  test('cancels a running task', async () => {
    render(<WorkspaceTaskList projectId="project-1" tasks={[{ id: 'task-1', title: 'Inspect source', status: 'RUNNING', progress: 10 }]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Inspect source' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Inspect source was cancelled.'))

    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/tasks/task-1/cancel', { method: 'POST' })
  })

  test('approves a pending task and refreshes the workspace', async () => {
    const onChanged = vi.fn()
    render(<WorkspaceTaskList projectId="project-1" onChanged={onChanged} tasks={[{ id: 'task-1', title: 'Inspect source', status: 'AWAITING_APPROVAL', progress: 0, approval: { id: 'approval-1', status: 'PENDING' } }]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve Inspect source' }))
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

  test('keeps worker details out of the primary running status', () => {
    render(<WorkspaceTaskList projectId="project-1" tasks={[{ id: 'task-1', title: 'Inspect source', status: 'RUNNING', progress: 35, leaseOwner: 'worker-a', leaseHeartbeatAt: new Date().toISOString() }]} />)

    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.queryByText('worker-a')).toBeNull()
  })

  test('shows live analyzer phase for running tasks', () => {
    render(<WorkspaceTaskList projectId="project-1" tasks={[{ id: 'task-1', title: 'Decompile Android package', status: 'RUNNING', progress: 10, progressMessage: 'Indexing Java source 12 of 80', leaseOwner: 'worker-a', leaseHeartbeatAt: new Date().toISOString() }]} />)

    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Indexing Java source 12 of 80')).toBeInTheDocument()
  })

  test('labels an old heartbeat as stale', () => {
    expect(heartbeatLabel(new Date(Date.now() - 120_000).toISOString())).toBe('heartbeat stale (2m ago)')
    expect(heartbeatLabel(null)).toBe('heartbeat pending')
  })
})

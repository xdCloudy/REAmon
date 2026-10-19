/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkspaceAnalysisPlanPanel, type WorkspaceAnalysisPlan } from './WorkspaceAnalysisPlan'

const plan: WorkspaceAnalysisPlan = {
  candidateArtifacts: 1,
  returnedArtifacts: 1,
  proposedSteps: 1,
  hasMoreArtifacts: false,
  hasMoreSteps: false,
  steps: [{
    id: 'artifact-1:reamon-source-inspector:extract_strings',
    status: 'PROPOSED',
    artifactId: 'artifact-1',
    relativePath: 'src/main.c',
    profile: {
      targetType: 'FILE', format: 'source', mimeType: 'text/x-c', extension: 'c', architecture: null,
      platform: null, runtimes: [], embeddedArtifacts: [], entropy: null, metadata: {},
    },
    capability: 'extract_strings',
    provider: {
      pluginId: 'reamon-source-inspector', pluginName: 'REAmon Strings Inspector', category: 'static_analysis', integration: 'native',
      acceptsTargetTypes: ['FILE'], acceptsFormats: ['*'], capabilities: ['extract_strings'], produces: ['String'], requirements: [],
    },
    reason: 'Strings inspector advertises extract_strings.',
  }],
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('WorkspaceAnalysisPlanPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ scheduled: true, task: { status: 'QUEUED' } }),
    }))
  })

  test('runs a proposal directly and reports the queued lifecycle', async () => {
    const onScheduled = vi.fn()
    render(<WorkspaceAnalysisPlanPanel projectId="project-1" plan={plan} isLoading={false} isError={false} onScheduled={onScheduled} />)

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('extract_strings is queued for src/main.c.'))

    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/analysis-plan/schedule', expect.objectContaining({
      method: 'POST',
      body: expect.stringMatching(/"artifactId":"artifact-1".*"providerId":"reamon-source-inspector".*"capability":"extract_strings".*"approvalRequired":false.*"runAttemptId":"[a-f0-9]{32}"/),
    }))
    expect(onScheduled).toHaveBeenCalledOnce()
  })

  test('shows a failed run reason beside the proposal status', () => {
    const failedPlan: WorkspaceAnalysisPlan = {
      ...plan,
      steps: [{
        ...plan.steps[0],
        latestTask: {
          id: 'task-1', status: 'FAILED', progress: 25, progressMessage: 'Compiling source',
          error: 'Analyzer worker ran out of memory', leaseHeartbeatAt: null, updatedAt: new Date().toISOString(),
        },
      }],
    }
    render(<WorkspaceAnalysisPlanPanel projectId="project-1" plan={failedPlan} isLoading={false} isError={false} />)

    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Analyzer worker ran out of memory')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear extract_strings proposal for src/main.c' })).toBeInTheDocument()
  })

  test('scans the whole project and explains what informed the rebuilt proposals', async () => {
    const onScanned = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ artifactsScanned: 12, proposalCount: 4, previousTasks: 3, findings: 2, hypotheses: 1, evidence: 5 }),
    }))
    render(<WorkspaceAnalysisPlanPanel projectId="project-1" plan={plan} isLoading={false} isError={false} onScanned={onScanned} />)

    fireEvent.click(screen.getByRole('button', { name: 'Scan project' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Scanned 12 files and rebuilt 4 proposals'))
    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/analysis-plan/scan', { method: 'POST' })
    expect(onScanned).toHaveBeenCalledOnce()
  })

  test('clears one proposal and tells the user to scan to restore it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ cleared: true }) }))
    render(<WorkspaceAnalysisPlanPanel projectId="project-1" plan={plan} isLoading={false} isError={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear extract_strings proposal for src/main.c' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('extract_strings for src/main.c was cleared. Scan the project to restore it.'))
    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/analysis-plan/clear', expect.objectContaining({ method: 'POST' }))
  })
})

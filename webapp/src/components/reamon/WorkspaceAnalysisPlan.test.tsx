/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkspaceAnalysisPlanPanel, type WorkspaceAnalysisPlan } from './WorkspaceAnalysisPlan'

const plan: WorkspaceAnalysisPlan = {
  query: {},
  candidateArtifacts: 1,
  returnedArtifacts: 1,
  proposedSteps: 1,
  totalCandidateSteps: 1,
  stepLimit: 500,
  stepOffset: 0,
  snapshotId: 'a'.repeat(64),
  nextStepOffset: null,
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

    fireEvent.click(screen.getByRole('button', { name: 'Run extract_strings for src/main.c' }))
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

  test('loads the next proposal step page with the same inventory snapshot', async () => {
    const nextStep = { ...plan.steps[0], id: 'artifact-2:reamon-source-inspector:decompile', capability: 'decompile' }
    const pagedPlan: WorkspaceAnalysisPlan = {
      ...plan,
      query: { search: 'engine', kind: 'executables', limit: 25, offset: 50 },
      proposedSteps: 1,
      totalCandidateSteps: 2,
      stepLimit: 1,
      nextStepOffset: 1,
      hasMoreSteps: true,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...pagedPlan,
        steps: [nextStep],
        proposedSteps: 1,
        stepOffset: 1,
        nextStepOffset: null,
        hasMoreSteps: false,
      }),
    }))
    render(<WorkspaceAnalysisPlanPanel projectId="project-1" plan={pagedPlan} isLoading={false} isError={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Load next 1 proposal step' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run decompile for src/main.c' })).toBeInTheDocument())

    const requestUrl = String(vi.mocked(fetch).mock.calls[0][0])
    expect(requestUrl).toContain('search=engine')
    expect(requestUrl).toContain('kind=executables')
    expect(requestUrl).toContain('offset=50')
    expect(requestUrl).toContain('stepOffset=1')
    expect(requestUrl).toContain('stepLimit=1')
    expect(requestUrl).toContain(`snapshotId=${'a'.repeat(64)}`)
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

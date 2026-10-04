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

  test('requests approval for a reviewed proposal and reports the task lifecycle', async () => {
    const onScheduled = vi.fn()
    render(<WorkspaceAnalysisPlanPanel projectId="project-1" plan={plan} isLoading={false} isError={false} onScheduled={onScheduled} />)

    fireEvent.click(screen.getByRole('button', { name: 'Request approval' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('extract_strings is awaiting operator approval for src/main.c.'))

    expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/workspace/analysis-plan/schedule', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ artifactId: 'artifact-1', providerId: 'reamon-source-inspector', capability: 'extract_strings', approvalRequired: true }),
    }))
    expect(onScheduled).toHaveBeenCalledOnce()
  })
})

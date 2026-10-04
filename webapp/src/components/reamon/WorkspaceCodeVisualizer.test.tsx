/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorkspaceCodeVisualizer } from './WorkspaceCodeVisualizer'
import type { CodeUnit } from '@/lib/reamon/code-units'

function unit(overrides: Partial<CodeUnit> = {}): CodeUnit {
  return {
    id: 'unit-1', name: 'app.MainActivity.onCreate', address: '0x1000', sizeBytes: 1024,
    coveragePercent: 35, language: 'Java', unitType: 'method', artifactId: 'artifact-1',
    artifactPath: 'classes.dex', source: 'jadx', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/app/MainActivity.java', updatedAt: '2026-10-04T00:00:00.000Z',
    ...overrides,
  }
}

function renderVisualizer(hasApk = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceCodeVisualizer projectId="project-1" hasApk={hasApk} isAnalyzing={false} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('WorkspaceCodeVisualizer', () => {
  test('states that an imported APK has no decompiled code units yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units: [], total: 0, hasMore: false }) }))
    renderVisualizer()

    expect(await screen.findByText('The APK is stored and identified; no code has been decompiled yet.')).toBeInTheDocument()
    expect(screen.getByText(/An analyzer must publish functions or other code units/)).toBeInTheDocument()
  })

  test('filters, selects a code unit, and links to its stored code artifact', async () => {
    const units = [unit(), unit({ id: 'unit-2', name: 'app.MainActivity.onPause', sizeBytes: 2048 })]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units, total: 2, hasMore: false }) }))
    renderVisualizer()

    const filter = await screen.findByRole('textbox', { name: 'Filter code units' })
    fireEvent.change(filter, { target: { value: 'onPause >1kb <70%' } })
    fireEvent.click(await screen.findByRole('button', { name: /app\.MainActivity\.onPause/ }))

    expect(await screen.findByText('Selected code unit')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open decompiled code' })).toHaveAttribute('href', '/api/projects/project-1/artifacts/artifact-1/decompiled/project-1/artifact-1/task-1/run-1/sources/app/MainActivity.java')
    await waitFor(() => expect(screen.queryByRole('button', { name: /app\.MainActivity\.onCreate/ })).toBeNull())
  })
})

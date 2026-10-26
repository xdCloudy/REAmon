/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WorkspaceCodeVisualizer } from './WorkspaceCodeVisualizer'
import type { CodeUnit } from '@/lib/reamon/code-units'

function unit(overrides: Partial<CodeUnit> = {}): CodeUnit {
  return {
    id: 'unit-1', name: 'app.MainActivity.onCreate', address: '0x1000', sizeBytes: 1024,
    coveragePercent: 35, language: 'Java', unitType: 'method', artifactId: 'artifact-1', disassemblyArtifactId: null, disassemblyLanguage: null,
    artifactPath: 'classes.dex', source: 'jadx', codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/app/MainActivity.java', updatedAt: '2026-10-04T00:00:00.000Z',
    ...overrides,
  }
}

function renderVisualizer(props: { isAnalyzing?: boolean; decompilationTask?: { status: string; progressMessage?: string | null }; decompilationHref?: string; standalone?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceCodeVisualizer projectId="project-1" isAnalyzing={props.isAnalyzing ?? false} analysisTask={props.decompilationTask} analysisHref={props.decompilationHref} standalone={props.standalone} />
    </QueryClientProvider>,
  )
}

function openDetails(name: string) {
  const disclosure = [...document.querySelectorAll('details')].find((element) => element.querySelector('summary')?.textContent?.includes(name))
  if (disclosure && !disclosure.open) fireEvent.click(disclosure.querySelector('summary') as HTMLElement)
}

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  vi.unstubAllGlobals()
})

describe('WorkspaceCodeVisualizer', () => {
  test('links into the focused visualizer and back to the project workspace', () => {
    const workspace = renderVisualizer()
    expect(screen.getByRole('link', { name: 'Open full visualizer' })).toHaveAttribute('href', '/projects/project-1/visualizer')
    workspace.unmount()

    renderVisualizer({ standalone: true })
    expect(screen.getByRole('link', { name: 'Back to workspace' })).toHaveAttribute('href', '/projects/project-1')
  })

  test('shows separate decompilation and maintainable-source progress for the selected run', async () => {
    const run = { id: 'run-1', title: 'JADX run', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z', artifactName: 'app.apk', providerId: 'reamon-jadx', codeUnitCount: 2, unitLabel: 'classes', discoveredUnitCount: 2, returnedUnitCount: 2, indexedUnitCount: 2, linkPercent: 100, codeBytes: 100, truncated: false, warnings: '', failedUnitCount: null, visitedUnitCount: null }
    const fetchMock = vi.fn((input: string) => input.includes('/visualizer/coverage')
      ? Promise.resolve({ ok: true, json: async () => ({ taskId: 'run-1', codeUnitCount: 2, maintainedUnitCount: 1, coveragePercent: 50, decompilationCoveragePercent: 70, sourceLinkedPercent: 100, codeBytes: 100, measuredBytes: 100 }) })
      : Promise.resolve({ ok: true, json: async () => ({ units: [unit()], total: 2, hasMore: false, selectedRunId: 'run-1', runs: [run] }) }))
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    expect(await screen.findByRole('progressbar', { name: 'Measured decompilation completeness' })).toHaveAttribute('aria-valuenow', '70')
    expect(await screen.findByRole('progressbar', { name: 'Maintained source coverage' })).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByText('1 of 2 code units have a saved maintained copy')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/visualizer/coverage?taskId=run-1', expect.objectContaining({ cache: 'no-store' }))
  })

  test('opens the latest completed run without the run history pager or call graph view', async () => {
    const run = { id: 'run-new', title: 'Latest analysis', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z', artifactName: 'app.apk', providerId: 'reamon-jadx', codeUnitCount: 2, unitLabel: 'classes', discoveredUnitCount: 2, returnedUnitCount: 2, indexedUnitCount: 2, notObservedUnitCount: 0, notIndexedUnitCount: 0, unreturnedDiscoveredUnitCount: 0, skippedUnitCount: 0, unsupportedUnitCount: 0, excludedUnitCount: 0, omittedUnitCount: 0, linkPercent: 100, codeBytes: 4096, truncated: false, inventoryAvailable: true, warnings: '', failedUnitCount: null, visitedUnitCount: null, notVisitedUnitCount: 0 }
    vi.stubGlobal('fetch', vi.fn((input: string) => input.includes('/visualizer/coverage')
      ? Promise.resolve({ ok: true, json: async () => ({ taskId: run.id, codeUnitCount: 2, maintainedUnitCount: 0, coveragePercent: 0, decompilationCoveragePercent: 100, sourceLinkedPercent: 100, codeBytes: 4096, measuredBytes: 4096 }) })
      : Promise.resolve({ ok: true, json: async () => ({
        units: [unit({ id: 'latest-unit', name: 'latest.Main' })], total: 1, hasMore: false,
        runs: [run, { ...run, id: 'run-old', title: 'Previous analysis' }], selectedRunId: run.id,
      }) })))
    renderVisualizer()

    expect(await screen.findByRole('button', { name: /latest\.Main/ })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Analysis run history' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Previous run' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next run' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Latest run' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Call graph' })).not.toBeInTheDocument()
  })

  test('keeps unsuccessful runs in a closed, expandable disclosure', async () => {
    const run = { id: 'run-1', title: 'Latest analysis', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z', artifactName: 'app.apk', providerId: 'reamon-jadx', codeUnitCount: 1, unitLabel: 'classes', discoveredUnitCount: 1, returnedUnitCount: 1, indexedUnitCount: 1, notObservedUnitCount: 0, notIndexedUnitCount: 0, unreturnedDiscoveredUnitCount: 0, skippedUnitCount: 0, unsupportedUnitCount: 0, excludedUnitCount: 0, omittedUnitCount: 0, linkPercent: 100, codeBytes: 1024, truncated: false, inventoryAvailable: true, warnings: '', failedUnitCount: null, visitedUnitCount: null, notVisitedUnitCount: 0 }
    vi.stubGlobal('fetch', vi.fn((input: string) => input.includes('/visualizer/coverage')
      ? Promise.resolve({ ok: true, json: async () => ({ taskId: run.id, codeUnitCount: 1, maintainedUnitCount: 0, coveragePercent: 0, decompilationCoveragePercent: 100, sourceLinkedPercent: 100, codeBytes: 1024, measuredBytes: 1024 }) })
      : Promise.resolve({ ok: true, json: async () => ({
        units: [unit()], total: 1, hasMore: false, runs: [run], selectedRunId: run.id,
        failedRuns: [{ id: 'run-failed', title: 'Failed JADX run', status: 'FAILED', progressMessage: 'Starting analysis', error: 'Worker unavailable', createdAt: '2026-10-03T00:00:00.000Z', completedAt: '2026-10-03T00:00:10.000Z', artifactName: 'app.apk' }],
      }) })))
    renderVisualizer()

    const summary = await screen.findByText(/Recent unsuccessful runs \(1\)/)
    const disclosure = summary.closest('details') as HTMLDetailsElement
    expect(disclosure.open).toBe(false)
    fireEvent.click(summary)
    expect(disclosure.open).toBe(true)
    expect(screen.getByText(/Failed JADX run/)).toBeInTheDocument()
    fireEvent.click(summary)
    expect(disclosure.open).toBe(false)
    expect(disclosure.open).toBe(false)
  })

  test('explains partial APK coverage and links to a fresh run', async () => {
    const partialRun = {
      id: 'run-partial', title: 'Partial JADX run', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z',
      artifactName: 'app.apk', providerId: 'reamon-jadx', codeUnitCount: 500, unitLabel: 'classes', discoveredUnitCount: 5000,
      returnedUnitCount: 500, indexedUnitCount: 500, linkPercent: 10, codeBytes: 4096, truncated: true, warnings: '', failedUnitCount: null, visitedUnitCount: null,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      units: [unit()], total: 500, hasMore: false, runs: [partialRun], selectedRunId: partialRun.id,
    }) }))
    renderVisualizer({ decompilationHref: '#analysis-next-step' })

    expect(await screen.findByText('500 code units indexed of 5,000 discovered classes')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar', { name: 'Indexed code unit coverage' })).not.toBeInTheDocument()
    openDetails('Run diagnostics')
    expect(screen.getByText(/Partial index\. The counts below describe stored output/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View analysis proposals' })).toHaveAttribute('href', '#analysis-next-step')
  })

  test('shows unreconstructed DEX class identities and reasons in run diagnostics', async () => {
    const run = {
      id: 'run-dex', title: 'Rust DEX run', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z',
      artifactName: 'app.apk', providerId: 'reamon-dex-decompiler', codeUnitCount: 1, unitLabel: 'code units', discoveredUnitCount: 2,
      returnedUnitCount: 1, indexedUnitCount: 1, notObservedUnitCount: 1, notIndexedUnitCount: 0, unreturnedDiscoveredUnitCount: 1,
      skippedUnitCount: 0, unsupportedUnitCount: 0, excludedUnitCount: 0, omittedUnitCount: 0, linkPercent: 50,
      codeBytes: 32, truncated: true, inventoryAvailable: true, warnings: '', failedUnitCount: null, visitedUnitCount: null,
      notVisitedUnitCount: null, failedClassDetails: [{ dexEntry: 'classes2.dex', classIndex: 8, descriptor: 'Lcom/example/Broken;', reason: 'class reconstruction timed out' }],
      failedClassDetailsTruncated: false,
    }
    vi.stubGlobal('fetch', vi.fn((input: string) => input.includes('/visualizer/coverage')
      ? Promise.resolve({ ok: true, json: async () => ({ taskId: run.id, codeUnitCount: 1, maintainedUnitCount: 0, coveragePercent: 0, decompilationCoveragePercent: null, sourceLinkedPercent: 100, codeBytes: 32, measuredBytes: 0 }) })
      : Promise.resolve({ ok: true, json: async () => ({ units: [unit()], total: 1, hasMore: false, runs: [run], selectedRunId: run.id }) })))
    renderVisualizer()

    await screen.findByText(/Run diagnostics · issues reported/)
    openDetails('Run diagnostics')
    expect(await screen.findByText('Unreconstructed DEX classes')).toBeInTheDocument()
    expect(screen.getByText('Lcom/example/Broken;')).toBeInTheDocument()
    expect(screen.getByText(/class reconstruction timed out/)).toBeInTheDocument()
  })

  test('does not show a percentage when the analyzer reached its scan limit', async () => {
    const partialRun = {
      id: 'run-unknown-count', title: 'Limited JADX run', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z', artifactName: 'app.apk', codeUnitCount: 5000, unitLabel: 'classes', discoveredUnitCount: null,
      returnedUnitCount: 5000, indexedUnitCount: 5000, linkPercent: null, codeBytes: 4096, truncated: true, warnings: 'Source scan stopped at its configured limit.', failedUnitCount: null, visitedUnitCount: null,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      units: [unit()], total: 5000, hasMore: false, runs: [partialRun], selectedRunId: partialRun.id,
    }) }))
    renderVisualizer({ decompilationHref: '#analysis-next-step' })

    expect(await screen.findByText('5,000 code units indexed')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar', { name: 'Indexed code unit coverage' })).not.toBeInTheDocument()
    openDetails('Run diagnostics')
    expect(screen.getByText(/Partial index\. The counts below describe stored output/)).toBeInTheDocument()
  })

  test('shows method and relationship evidence coverage separately from decompiled class coverage', async () => {
    const partialRun = {
      id: 'run-dex-methods', title: 'Rust DEX run', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z',
      artifactName: 'app.apk', providerId: 'reamon-dex-decompiler', codeUnitCount: 1, unitLabel: 'code units', discoveredUnitCount: 1,
      returnedUnitCount: 1, indexedUnitCount: 1, linkPercent: 100, codeBytes: 4096, truncated: false, warnings: '', failedUnitCount: null,
      visitedUnitCount: null, discoveredMethodCount: 12_400, returnedMethodCount: 10_000, indexedMethodCount: 9_950, methodsTruncated: true,
      returnedCallCount: 4_000, callGraphTruncated: true, returnedReferenceCount: 4_000, referencesTruncated: true,
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      units: [unit()], total: 1, hasMore: false, runs: [partialRun], selectedRunId: partialRun.id,
    }) }))
    renderVisualizer()

    openDetails('Run diagnostics')
    expect(await screen.findByText('9,950 of 12,400 discovered methods indexed (10,000 returned by the analyzer).')).toBeInTheDocument()
    expect(screen.getByText('Method evidence is incomplete; the analyzer or result ingestion reached a method limit.')).toBeInTheDocument()
    expect(screen.getByText('4,000 call edges returned; the call graph is truncated.')).toBeInTheDocument()
    expect(screen.getByText('4,000 field/string references returned; reference evidence is truncated.')).toBeInTheDocument()
  })
  test('offers a direct route to decompilation when an artifact is ready but has no code units', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units: [], total: 0, hasMore: false }) }))
    renderVisualizer({ decompilationHref: '#analysis-next-step' })

    expect(await screen.findByText('No code units have been analyzed yet.')).toBeInTheDocument()
    expect(screen.getByText(/run a compatible analysis proposal to populate this map/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View analysis proposals' })).toHaveAttribute('href', '#analysis-next-step')
  })

  test('shows a running state instead of the empty-result prompt while analysis is active', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units: [], total: 0, hasMore: false }) }))
    renderVisualizer({ isAnalyzing: true, decompilationTask: { status: 'RUNNING', progressMessage: 'Indexing Java source 3 of 10' }, decompilationHref: '#analysis-next-step' })

    expect(await screen.findByText('Analysis is running.')).toBeInTheDocument()
    expect(screen.getByText('Indexing Java source 3 of 10')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'View analysis proposals' })).not.toBeInTheDocument()
  })

  test('sends queued and approval-blocked runs to task controls', async () => {
    for (const [status, label] of [
      ['QUEUED', 'Analysis is queued.'],
      ['AWAITING_APPROVAL', 'Analysis is waiting for approval.'],
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units: [], total: 0, hasMore: false }) }))
      const view = renderVisualizer({ decompilationTask: { status } })

      expect(await screen.findByText(label)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Open task controls' })).toHaveAttribute('href', '#analysis-tasks')
      view.unmount()
      vi.unstubAllGlobals()
    }
  })

  test('filters, selects a code unit, and links to its stored code artifact', async () => {
    const units = [unit(), unit({ id: 'unit-2', name: 'app.MainActivity.onPause', sizeBytes: 2048, maintainedSource: true })]
    const fetchMock = vi.fn((input: string) => {
      if (input.includes('/visualizer/providers')) return Promise.resolve({ ok: true, json: async () => ({ providers: [{ id: 'provider-1', name: 'Local Qwen', modelIdentifier: 'Qwen3.5-0.8B' }] }) })
      if (input.includes('/decompiled/')) return Promise.resolve({ ok: true, text: async () => 'void onPause() {\n    saveState();\n}' })
      return Promise.resolve({ ok: true, json: async () => ({ units, total: 2, hasMore: false }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    const filter = await screen.findByRole('textbox', { name: 'Filter code units' })
    fireEvent.change(filter, { target: { value: 'onPause >1kb <70%' } })
    fireEvent.click(await screen.findByRole('button', { name: /app\.MainActivity\.onPause/ }))
    openDetails('Map metrics')

    expect(await screen.findByText('Selected code unit')).toBeInTheDocument()
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('unitId')).toBe('unit-2'))
    expect(within(screen.getByText('Code units in this map').parentElement!).getByText('1')).toBeInTheDocument()
    expect(screen.getByText('Viewable source links in map (1/1)')).toBeInTheDocument()
    expect(screen.getByText('Maintained source copies in map').previousSibling).toHaveTextContent('1')
    expect(screen.getByText(/Viewable source links/)).toBeInTheDocument()
    expect(screen.getByText('Decompilation completeness of measured bytes in map')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open code separately' })).toHaveAttribute('href', '/api/projects/project-1/artifacts/artifact-1/decompiled/project-1/artifact-1/task-1/run-1/sources/app/MainActivity.java')
    await waitFor(() => expect(screen.getByRole('region', { name: 'Decompiled source' }).querySelector('code')?.textContent).toContain('saveState();'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Explain selected code' })).toBeVisible())
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/decompiled/'))).toBe(true)
    await waitFor(() => expect(screen.queryByRole('button', { name: /app\.MainActivity\.onCreate/ })).toBeNull())
  })

  test('restores a selected code unit from a deep link outside the first map page', async () => {
    window.history.replaceState({}, '', '/projects/project-1/visualizer?taskId=run-1&unitId=unit-2')
    const deepUnit = unit({ id: 'unit-2', name: 'app.MainActivity.onPause' })
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      const url = new URL(input, window.location.origin)
      if (url.pathname.endsWith('/visualizer/providers')) return Promise.resolve({ ok: true, json: async () => ({ providers: [] }) })
      if (url.pathname.endsWith('/visualizer') && url.searchParams.has('unitId')) {
        return Promise.resolve({ ok: true, json: async () => ({ units: [deepUnit], total: 1, hasMore: false, selectedRunId: 'run-1', runs: [] }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({ units: [unit()], total: 1200, hasMore: true, nextCursor: 'cursor-1', selectedRunId: 'run-1', runs: [] }) })
    }))
    renderVisualizer()

    expect(await screen.findByText('Selected code unit')).toBeInTheDocument()
    expect(screen.getAllByText('app.MainActivity.onPause').length).toBeGreaterThan(1)
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('unitId')).toBe('unit-2'))
  })

  test('opens on individual code units and keeps package drill-down available', async () => {
    const run = { id: 'run-1', title: 'Latest analysis', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z', artifactName: 'app.apk', providerId: 'reamon-jadx', codeUnitCount: 1, unitLabel: 'classes', discoveredUnitCount: 1, returnedUnitCount: 1, indexedUnitCount: 1, linkPercent: 100, codeBytes: 1024, truncated: false, warnings: '', failedUnitCount: null, visitedUnitCount: null }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units: [unit({ unitType: 'class' })], total: 1, hasMore: false, selectedRunId: run.id, runs: [run] }) }))
    renderVisualizer()

    expect(await screen.findByRole('button', { name: /app\.MainActivity\.onCreate/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Treemap' }))
    openDetails('Map options')
    const contents = screen.getByRole('group', { name: 'Treemap contents' })
    expect(within(contents).getByRole('button', { name: 'Code units' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(contents).getByRole('button', { name: 'Folders' }))

    expect(await screen.findByRole('button', { name: /app folder/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /app\.MainActivity\.onCreate/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /app folder/ }))
    expect(await screen.findByRole('button', { name: /app\.MainActivity\.onCreate/ })).toBeInTheDocument()
  })

  test('keeps very large decompiled files responsive by limiting syntax highlighting to a preview', async () => {
    const largeSource = `class LargeSource {\n${'  int value = 1;\n'.repeat(4000)}}`
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      if (input.includes('/decompiled/')) return Promise.resolve({ ok: true, text: async () => largeSource })
      if (input.includes('/visualizer/providers')) return Promise.resolve({ ok: true, json: async () => ({ providers: [] }) })
      if (input.includes('/visualizer/maintained/')) return Promise.resolve({ ok: true, json: async () => ({ exists: false, sourceCode: null }) })
      return Promise.resolve({ ok: true, json: async () => ({ units: [unit()], total: 1, hasMore: false }) })
    }))
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: /app\.MainActivity\.onCreate/ }))

    const sourceRegion = await screen.findByRole('region', { name: 'Decompiled source' })
    await waitFor(() => expect(sourceRegion.querySelector('code')?.textContent).toContain('int value = 1;'))
    expect(sourceRegion.querySelector('code')?.textContent?.length).toBeLessThan(32_000)
    expect(within(sourceRegion).getByRole('status')).toHaveTextContent('Showing the first 25,000 characters')
    expect(within(sourceRegion).getByRole('link', { name: 'Open the full artifact' })).toHaveAttribute('href', '/api/projects/project-1/artifacts/artifact-1/decompiled/project-1/artifact-1/task-1/run-1/sources/app/MainActivity.java')
  })

  test('rewrites one method at a time for a Java class above the single request limit', async () => {
    const method = 'public String a() { return "x"; }'
    const source = `class BigSource { ${method} /*${'large source '.repeat(7000)}*/ }`
    const startByte = new TextEncoder().encode('class BigSource { ').byteLength
    const endByte = startByte + new TextEncoder().encode(method).byteLength
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input.includes('/decompiled/')) return Promise.resolve({ ok: true, text: async () => source })
      if (input.includes('/visualizer/providers')) return Promise.resolve({ ok: true, json: async () => ({ providers: [{ id: 'provider-1', name: 'Local Qwen', modelIdentifier: 'Qwen3.5-0.8B' }] }) })
      if (input.includes('/visualizer/maintained/')) return Promise.resolve({ ok: true, json: async () => ({ exists: false, sourceCode: null }) })
      if (input.includes('/visualizer/deobfuscate')) {
        const body = JSON.parse(String(init?.body))
        if (body.scope === 'outline') return Promise.resolve({ ok: true, json: async () => ({ members: [{ name: 'a', kind: 'method', start_byte: startByte, end_byte: endByte, line: 1, source_bytes: method.length }], truncated: false }) })
        return Promise.resolve({ ok: true, json: async () => ({ sourceCode: 'public String a() { return "x".trim(); }', providerName: 'Local Qwen', model: 'Qwen3.5-0.8B', syntaxValidated: true }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({ units: [unit({ unitType: 'class' })], total: 1, hasMore: false }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: /app\.MainActivity\.onCreate/ }))
    expect(await screen.findByText('Reverse engineer functions and methods with AI agents')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create maintainable version' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /method a · line 1/ }))

    const editable = await screen.findByRole('textbox', { name: 'Editable maintained source' })
    await waitFor(() => expect(editable).toHaveValue(source.replace(method, 'public String a() { return "x".trim(); }')))
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/visualizer/deobfuscate', expect.objectContaining({
      method: 'POST', body: expect.stringContaining('"scope":"member"'),
    }))
  })

  test('replaces a method in a saved draft after its formatting has changed', async () => {
    const method = 'public String a() { return "x"; }'
    const source = `class BigSource { ${method} /*${'large source '.repeat(7000)}*/ }`
    const draftMethod = 'public String a() {\n    return "existing";\n  }'
    const draftSource = source.replace(method, draftMethod)
    const outlineFor = (outlineSource: string, memberSource: string) => {
      const start = new TextEncoder().encode(outlineSource.slice(0, outlineSource.indexOf(memberSource))).byteLength
      const end = start + new TextEncoder().encode(memberSource).byteLength
      return { members: [{ name: 'a', kind: 'method', start_byte: start, end_byte: end, line: 1, source_bytes: end - start }], truncated: false }
    }
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input.includes('/decompiled/')) return Promise.resolve({ ok: true, text: async () => source })
      if (input.includes('/visualizer/providers')) return Promise.resolve({ ok: true, json: async () => ({ providers: [{ id: 'provider-1', name: 'Local Qwen', modelIdentifier: 'Qwen3.5-0.8B' }] }) })
      if (input.includes('/visualizer/maintained/')) return Promise.resolve({ ok: true, json: async () => ({ exists: false, sourceCode: null }) })
      if (input.includes('/visualizer/drafts/')) {
        return Promise.resolve({ ok: true, json: async () => init?.method === 'POST'
          ? { saved: true, draftId: 'draft-next', updatedAt: '2026-10-05T12:00:00.000Z' }
          : { exists: true, draft: { id: 'draft-prior', sourceCode: draftSource, providerName: 'Local Qwen', modelIdentifier: 'Qwen3.5-0.8B', question: '', scope: 'member', syntaxValidated: true, updatedAt: '2026-10-05T11:00:00.000Z' } } })
      }
      if (input.includes('/visualizer/deobfuscate')) {
        const body = JSON.parse(String(init?.body))
        if (body.scope === 'outline') return Promise.resolve({ ok: true, json: async () => outlineFor(body.sourceCode || source, body.sourceCode ? draftMethod : method) })
        return Promise.resolve({ ok: true, json: async () => ({ sourceCode: 'public String a() { return "x".trim(); }', providerName: 'Local Qwen', model: 'Qwen3.5-0.8B', syntaxValidated: true }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({ units: [unit({ unitType: 'class' })], total: 1, hasMore: false }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: /app\.MainActivity\.onCreate/ }))
    const editable = await screen.findByRole('textbox', { name: 'Editable maintained source' })
    await waitFor(() => expect(editable).toHaveValue(draftSource))
    fireEvent.click(await screen.findByRole('button', { name: /method a · line 1/ }))

    const expected = draftSource.replace(draftMethod, 'public String a() { return "x".trim(); }')
    await waitFor(() => expect(editable).toHaveValue(expected))
    expect(screen.queryByText(/method has changed in the editable copy/)).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/visualizer/deobfuscate', expect.objectContaining({
      method: 'POST', body: expect.stringContaining('"sourceCode"'),
    }))
  })

  test('filters the map between units needing work and saved maintained copies', async () => {
    const units = [
      unit({ id: 'maintained-unit', name: 'app.Maintained', unitType: 'class', maintainedSource: true, coveragePercent: 100 }),
      unit({ id: 'needs-work-unit', name: 'app.NeedsWork', unitType: 'class', maintainedSource: false, coveragePercent: 35 }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units, total: 2, hasMore: false }) }))
    renderVisualizer()
    openDetails('Map options')

    const status = await screen.findByRole('group', { name: 'Maintained source status' })
    expect(within(status).getByRole('button', { name: 'All (2)' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(status).getByRole('button', { name: 'Maintained (1)' }))
    expect(within(status).getByRole('button', { name: 'Maintained (1)' })).toHaveAttribute('aria-pressed', 'true')
    openDetails('Map metrics')
    expect(within(screen.getByText('Code units in this map').parentElement!).getByText('1')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /app\.Maintained/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /app\.NeedsWork/ })).not.toBeInTheDocument()

    fireEvent.click(within(status).getByRole('button', { name: 'Needs work (1)' }))
    expect(within(status).getByRole('button', { name: 'Needs work (1)' })).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByRole('button', { name: /app\.NeedsWork/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /app\.Maintained/ })).not.toBeInTheDocument()
  })

  test('switches treemap colors between decompilation completeness and maintained source status', async () => {
    const units = [
      unit({ id: 'maintained-unit', name: 'app.Ready', unitType: 'class', maintainedSource: true, coveragePercent: 100 }),
      unit({ id: 'needs-work-unit', name: 'app.Pending', unitType: 'class', maintainedSource: false, coveragePercent: 35 }),
    ]
    const run = { id: 'run-1', title: 'Latest analysis', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z', artifactName: 'app.apk', providerId: 'reamon-jadx', codeUnitCount: 2, unitLabel: 'classes', discoveredUnitCount: 2, returnedUnitCount: 2, indexedUnitCount: 2, linkPercent: 100, codeBytes: 1024, truncated: false, warnings: '', failedUnitCount: null, visitedUnitCount: null }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units, total: 2, hasMore: false, selectedRunId: run.id, runs: [run] }) }))
    renderVisualizer()
    fireEvent.click(await screen.findByRole('button', { name: 'Treemap' }))
    openDetails('Map options')

    const maintainedTile = await screen.findByRole('button', { name: /app\.Ready/ })
    const pendingTile = await screen.findByRole('button', { name: /app\.Pending/ })
    const layers = screen.getByRole('group', { name: 'Treemap color layer' })
    fireEvent.click(within(layers).getByRole('button', { name: 'Decompilation' }))
    expect(maintainedTile.querySelector('rect')).toHaveAttribute('fill', 'var(--status-success, #00a876)')
    expect(pendingTile.querySelector('rect')).toHaveAttribute('fill', 'var(--status-warning, #b99a3b)')

    fireEvent.click(within(layers).getByRole('button', { name: 'Maintained source' }))
    expect(maintainedTile.querySelector('rect')).toHaveAttribute('fill', 'var(--status-success, #00a876)')
    expect(pendingTile.querySelector('rect')).toHaveAttribute('fill', 'var(--status-neutral-bg, #394458)')
    expect(screen.getByRole('group', { name: 'Maintained source legend' })).toBeInTheDocument()
  })

  test('offers a run source bundle that includes the complete selected decompilation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      units: [unit({ maintainedSource: true })], total: 1, maintainedCount: 1, hasMore: false, selectedRunId: 'run-1', runs: [{
        id: 'run-1', title: 'JADX run', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z',
        artifactName: 'app.apk', providerId: 'reamon-jadx', codeUnitCount: 1, unitLabel: 'classes', discoveredUnitCount: 1,
        returnedUnitCount: 1, indexedUnitCount: 1, linkPercent: 100, codeBytes: 100, truncated: false, warnings: '', failedUnitCount: null, visitedUnitCount: null,
      }],
    }) }))
    renderVisualizer()

    openDetails('Map options')
    const download = await screen.findByRole('link', { name: 'Download source bundle · 1 code unit' })
    expect(download).toHaveAttribute('href', '/api/projects/project-1/visualizer/maintained/export?taskId=run-1')
  })

  test('searches units beyond the first page of a run', async () => {
    const first = unit({ id: 'unit-first', name: 'app.First' })
    const later = unit({ id: 'unit-later', name: 'app.deep.Target' })
    const run = { id: 'run-new', title: 'Latest analysis', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z', artifactName: 'app.apk', codeUnitCount: 1200, unitLabel: 'classes', discoveredUnitCount: 1200, returnedUnitCount: 1200, indexedUnitCount: 1200, linkPercent: 100, codeBytes: 2048, truncated: false, warnings: '', failedUnitCount: null, visitedUnitCount: null }
    const requests: string[] = []
    const fetchMock = vi.fn((input: string) => {
      requests.push(input)
      const searching = input.includes('q=app.deep.target')
      return Promise.resolve({ ok: true, json: async () => ({
        units: [searching ? later : first], total: searching ? 1 : 1200,
        hasMore: !searching, nextCursor: searching ? null : 'unit-first', runs: [run], selectedRunId: 'run-new',
      }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    const filter = await screen.findByRole('textbox', { name: 'Filter code units' })
    fireEvent.change(filter, { target: { value: 'app.deep.Target' } })

    expect(await screen.findByRole('button', { name: /app\.deep\.Target/ })).toBeInTheDocument()
    await waitFor(() => expect(requests).toContain('/api/projects/project-1/visualizer?q=app.deep.target'))
    expect(screen.queryByRole('button', { name: /app\.First/ })).not.toBeInTheDocument()
    expect(screen.getByText(/search spans the full run/i)).toBeInTheDocument()
  })

  test('loads the next batch of code units within the selected run', async () => {
    const first = unit({ id: 'unit-first', name: 'app.first' })
    const second = unit({ id: 'unit-second', name: 'app.second', codeArtifactId: null })
    const run = { id: 'run-new', title: 'Latest analysis', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z', artifactName: 'app.exe', codeUnitCount: 2, unitLabel: 'functions', discoveredUnitCount: 2, returnedUnitCount: 2, indexedUnitCount: 2, linkPercent: 100, codeBytes: 2048, truncated: false, warnings: '', failedUnitCount: null, visitedUnitCount: null }
    const fetchMock = vi.fn((input: string) => {
      if (input.includes('cursor=')) return Promise.resolve({ ok: true, json: async () => ({ units: [second], total: 2, hasMore: false, nextCursor: null, runs: [run], selectedRunId: 'run-new' }) })
      return Promise.resolve({ ok: true, json: async () => ({ units: [first], total: 2, hasMore: true, nextCursor: 'unit-first', runs: [run], selectedRunId: 'run-new' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    expect(await screen.findByRole('button', { name: /app\.first/ })).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter code units' }), { target: { value: 'app' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/visualizer?q=app', expect.any(Object)))
    fireEvent.click(screen.getByRole('button', { name: 'Load more code units' }))

    expect(await screen.findByRole('button', { name: /app\.second/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more code units' })).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/visualizer?taskId=run-new&cursor=unit-first&q=app', expect.objectContaining({ cache: 'no-store' }))
  })

  test('loads one code-unit page at a time for large maps', async () => {
    const units = ['one', 'two', 'three', 'four', 'five'].map((name) => unit({ id: name, name: `app.${name}` }))
    const fetchMock = vi.fn((input: string) => {
      const page = input.includes('cursor=cursor-two')
        ? { units: [units[4]], total: 5, hasMore: false, nextCursor: null }
        : input.includes('cursor=cursor-one')
          ? { units: [units[2], units[3]], total: 5, hasMore: true, nextCursor: 'cursor-two' }
          : { units: [units[0], units[1]], total: 5, hasMore: true, nextCursor: 'cursor-one' }
      return Promise.resolve({ ok: true, json: async () => page })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: 'Load more code units' }))
    expect(await screen.findByRole('button', { name: 'Load more code units' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more code units' }))

    expect(await screen.findByText('5 code units', { exact: true })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more code units' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Load all/ })).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/visualizer?cursor=cursor-two', expect.objectContaining({ cache: 'no-store' }))
  })

  test('automatically completes a reference-sized map in the focused visualizer', async () => {
    const first = unit({ id: 'unit-first', name: 'app.First' })
    const second = unit({ id: 'unit-second', name: 'app.Second' })
    const run = { id: 'run-small', title: 'Latest analysis', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z', artifactName: 'app.apk', codeUnitCount: 2, unitLabel: 'classes', discoveredUnitCount: 2, returnedUnitCount: 2, indexedUnitCount: 2, linkPercent: 100, codeBytes: 2048, truncated: false, warnings: '', failedUnitCount: null, visitedUnitCount: null }
    const fetchMock = vi.fn((input: string) => input.includes('cursor=')
      ? Promise.resolve({ ok: true, json: async () => ({ units: [second], total: 1_469, hasMore: false, nextCursor: null, runs: [run], selectedRunId: 'run-small' }) })
      : Promise.resolve({ ok: true, json: async () => ({ units: [first], total: 1_469, hasMore: true, nextCursor: 'unit-first', runs: [run], selectedRunId: 'run-small' }) }))
    vi.stubGlobal('fetch', fetchMock)
    const { container } = renderVisualizer({ standalone: true })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/visualizer?taskId=run-small&cursor=unit-first', expect.objectContaining({ cache: 'no-store' })))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more code units' })).not.toBeInTheDocument())
    expect(container.querySelector('.badge')).toHaveTextContent('2 code units')
  })

  test('updates maintained status for a code unit loaded from a later map page', async () => {
    const first = unit({ id: 'unit-first', name: 'app.First' })
    const second = unit({ id: 'unit-second', name: 'app.Second' })
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input.includes('cursor=')) return Promise.resolve({ ok: true, json: async () => ({ units: [second], total: 2, hasMore: false, nextCursor: null }) })
      if (input.includes('/visualizer/maintained/') && init?.method === 'PUT') return Promise.resolve({ ok: true, json: async () => ({ saved: true }) })
      if (input.includes('/visualizer/maintained/')) return Promise.resolve({ ok: true, json: async () => ({ exists: false, sourceCode: null }) })
      if (input.includes('/decompiled/')) return Promise.resolve({ ok: true, text: async () => 'private String b;' })
      return Promise.resolve({ ok: true, json: async () => ({ units: [first], total: 2, hasMore: true, nextCursor: 'unit-first' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: 'Load more code units' }))
    fireEvent.click(await screen.findByRole('button', { name: /app\.Second/ }))
    const editable = await screen.findByRole('textbox', { name: 'Editable maintained source' })
    fireEvent.change(editable, { target: { value: 'private String accountName;' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Review rationale' }), { target: { value: 'Verified the source and identifiers.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review and accept maintained copy' }))

    openDetails('Map options')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Maintained (1)' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /app\.Second.*Maintained source saved/ })).toBeInTheDocument()
  })

  test('keeps maps above the automatic loading limit paged', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      units: [unit()], total: 20_001, hasMore: true, nextCursor: 'unit-first',
    }) })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = renderVisualizer({ standalone: true })

    await waitFor(() => expect(container.querySelector('.badge')).toHaveTextContent('1 / 20,001 code units'))
    const loadingControls = await screen.findByRole('group', { name: 'Map code unit loading' })
    const codeMap = screen.getByRole('group', { name: 'Language-neutral functions and code units map' })
    expect(screen.queryByRole('button', { name: /Load all/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load more code units' })).toBeInTheDocument()
    expect(loadingControls.compareDocumentPosition(codeMap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/projects/project-1/visualizer')).toHaveLength(1)
  })

  test('scrolls the selected code unit inspector into view', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units: [unit()], total: 1, hasMore: false }) }))
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: /app\.MainActivity\.onCreate/ }))
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' }))

    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original)
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  })

  test('compares Ghidra decompiled source with its linked disassembly', async () => {
    const native = unit({
      id: 'native-main', name: 'main', address: '00401000', language: 'C', unitType: 'function',
      codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/functions/main.c',
      disassemblyArtifactId: 'project-1/artifact-1/task-1/run-1/assembly/functions/main.asm', disassemblyLanguage: 'Assembly',
    })
    const fetchMock = vi.fn((input: string) => {
      if (input.includes('/decompiled/') && input.includes('/assembly/')) return Promise.resolve({ ok: true, text: async () => '00401000: PUSH RBP\n00401001: MOV RBP, RSP' })
      if (input.includes('/decompiled/')) return Promise.resolve({ ok: true, text: async () => 'int main(void) {\n    return 0;\n}' })
      return Promise.resolve({ ok: true, json: async () => ({ units: [native], total: 1, hasMore: false }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: /main/ }))
    const comparison = await screen.findByRole('region', { name: 'Decompilation and disassembly comparison' })
    expect(within(comparison).getByText('Decompiled source')).toBeInTheDocument()
    expect(within(comparison).getByText('Assembly')).toBeInTheDocument()
    await waitFor(() => expect(comparison.querySelectorAll('code')[1]?.textContent).toContain('MOV RBP, RSP'))
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/decompiled/project-1/artifact-1/task-1/run-1/assembly/functions/main.asm'), expect.any(Object))
  })

  test('labels the Android low-level pane as Smali', async () => {
    const android = unit({
      id: 'android-main', name: 'com.example.MainActivity', language: 'Java', unitType: 'class',
      codeArtifactId: 'project-1/artifact-1/task-1/run-1/sources/com/example/MainActivity.java',
      disassemblyArtifactId: 'project-1/artifact-1/task-1/run-1/disassembly/com/example/MainActivity.smali',
      disassemblyLanguage: 'Smali',
    })
    const run = { id: 'run-1', title: 'Latest analysis', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z', artifactName: 'app.apk', providerId: 'reamon-jadx', codeUnitCount: 1, unitLabel: 'classes', discoveredUnitCount: 1, returnedUnitCount: 1, indexedUnitCount: 1, linkPercent: 100, codeBytes: 1024, truncated: false, warnings: '', failedUnitCount: null, visitedUnitCount: null }
    const fetchMock = vi.fn((input: string) => {
      if (input.includes('/disassembly/')) return Promise.resolve({ ok: true, text: async () => '.method public onCreate()V\n    return-void\n.end method' })
      if (input.includes('/decompiled/')) return Promise.resolve({ ok: true, text: async () => 'public class MainActivity {}' })
      return Promise.resolve({ ok: true, json: async () => ({ units: [android], total: 1, hasMore: false, selectedRunId: run.id, runs: [run] }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: 'Treemap' }))
    openDetails('Map options')
    fireEvent.click(screen.getByRole('button', { name: 'Folders' }))
    fireEvent.click(await screen.findByRole('button', { name: /com folder/ }))
    fireEvent.click(await screen.findByRole('button', { name: /example folder/ }))
    fireEvent.click(await screen.findByRole('button', { name: /com\.example\.MainActivity/ }))
    const comparison = await screen.findByRole('region', { name: 'Decompilation and disassembly comparison' })
    expect(within(comparison).getByText('Smali')).toBeInTheDocument()
    expect(await within(comparison).findByText(/return-void/)).toBeInTheDocument()
  })

  test('labels WAT as disassembly and exposes its linked code', async () => {
    const wat = unit({
      id: 'wasm-function-0', name: 'function_0', address: '0', sizeBytes: 50,
      coveragePercent: null, language: 'WebAssembly Text (WAT)', unitType: 'function',
      artifactPath: 'module.wasm',
      codeArtifactId: 'project-1/artifact-1/task-1/run-1/functions/f00000.wat',
    })
    const fetchMock = vi.fn((input: string) => {
      if (input.includes('/visualizer/providers')) return Promise.resolve({ ok: true, json: async () => ({ providers: [] }) })
      if (input.includes('/decompiled/')) return Promise.resolve({ ok: true, text: async () => '(func (result i32) i32.const 42)' })
      return Promise.resolve({ ok: true, json: async () => ({ units: [wat], total: 1, hasMore: false }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: /function_0/ }))
    expect(await screen.findByRole('region', { name: 'WAT disassembly' })).toBeInTheDocument()
    expect(await screen.findByText(/i32\.const 42/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Copy code' })).toBeInTheDocument()
  })

  test('sends selected source only after explicit AI explain request', async () => {
    const units = [unit()]
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input.includes('/visualizer/providers')) return Promise.resolve({ ok: true, json: async () => ({ providers: [{ id: 'provider-local', name: 'Local Qwen', modelIdentifier: 'Qwen3.5-0.8B' }] }) })
      if (input.includes('/decompiled/')) return Promise.resolve({ ok: true, text: async () => 'return state.value;' })
      if (input.includes('/visualizer/explain')) return Promise.resolve({ ok: true, json: async () => ({ explanation: 'Reads the current value.', providerName: 'Local Qwen', model: 'Qwen3.5-0.8B', sourceTruncated: false }) })
      return Promise.resolve({ ok: true, json: async () => ({ units, total: 1, hasMore: false }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: /app\.MainActivity\.onCreate/ }))
    expect(await screen.findByText('When you choose Explain, this code is sent to the selected saved provider. API keys stay on the server. Check the explanation against the code before relying on it.')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/visualizer/explain'))).toBe(false)

    fireEvent.change(await screen.findByRole('textbox', { name: /Question about this code/ }), { target: { value: 'What state does it read?' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Explain selected code' }))

    expect(await screen.findByText('Reads the current value.')).toBeInTheDocument()
    const explainCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/visualizer/explain'))
    expect(explainCall?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(explainCall?.[1]?.body))).toMatchObject({ unitId: 'unit-1', providerId: 'provider-local', question: 'What state does it read?' })
  })

  test('creates an editable AI reverse-engineered copy and saves it separately', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    const units = [unit()]
    const fetchMock = vi.fn((input: string, init?: RequestInit) => {
      if (input.includes('/visualizer/providers')) return Promise.resolve({ ok: true, json: async () => ({ providers: [{ id: 'provider-local', name: 'Local Qwen', modelIdentifier: 'Qwen3.5-0.8B' }] }) })
      if (input.includes('/visualizer/drafts/')) {
        if (init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ saved: true, draftId: 'draft-1', updatedAt: '2026-10-04T12:00:00.000Z' }) })
        if (init?.method === 'PATCH') return Promise.resolve({ ok: true, json: async () => ({ saved: true, updatedAt: '2026-10-04T12:01:00.000Z' }) })
        return Promise.resolve({ ok: true, json: async () => ({ exists: false, draft: null }) })
      }
      if (input.includes('/visualizer/maintained/') && init?.method !== 'PUT') return Promise.resolve({ ok: true, json: async () => ({ exists: false, sourceCode: null }) })
      if (input.includes('/decompiled/')) return Promise.resolve({ ok: true, text: async () => 'private String a;' })
      if (input.includes('/visualizer/deobfuscate')) return Promise.resolve({ ok: true, json: async () => ({ sourceCode: 'private String accountName;', providerName: 'Local Qwen', model: 'Qwen3.5-0.8B', syntaxValidated: true }) })
      if (input.includes('/visualizer/maintained/') && init?.method === 'PUT') return Promise.resolve({ ok: true, json: async () => ({ saved: true }) })
      return Promise.resolve({ ok: true, json: async () => ({ units, total: 1, hasMore: false }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: /app\.MainActivity\.onCreate/ }))
    const editable = await screen.findByRole('textbox', { name: 'Editable maintained source' })
    expect(editable).toHaveValue('private String a;')
    expect(screen.getByRole('button', { name: 'Review and accept maintained copy' })).toBeDisabled()
    expect(screen.getByText('Edit the decompilation or create a maintained version before saving.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create maintainable version' }))
    await waitFor(() => expect(editable).toHaveValue('private String accountName;'))
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' }))
    expect(editable).toHaveFocus()
    expect(await screen.findByText(/The source parser found no syntax errors/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Draft saved to project memory' })).toBeDisabled()
    fireEvent.change(editable, { target: { value: 'private String accountName;\n' } })
    expect(await screen.findByText(/This draft has changed or predates saved validation metadata/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Draft saved to project memory' })).toBeDisabled())
    fireEvent.change(screen.getByRole('textbox', { name: 'Review rationale' }), { target: { value: 'Verified the source and identifiers.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review and accept maintained copy' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Accepted source and review receipt saved separately'))
    const transformCall = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/visualizer/deobfuscate') && JSON.parse(String(init?.body)).scope !== 'outline')
    expect(JSON.parse(String(transformCall?.[1]?.body))).toMatchObject({ unitId: 'unit-1', providerId: 'provider-local' })
    const draftCreate = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/visualizer/drafts/') && init?.method === 'POST')
    expect(JSON.parse(String(draftCreate?.[1]?.body))).toMatchObject({ sourceCode: 'private String accountName;', providerName: 'Local Qwen', model: 'Qwen3.5-0.8B', scope: 'file', syntaxValidated: true })
    const draftUpdate = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/visualizer/drafts/') && init?.method === 'PATCH')
    expect(JSON.parse(String(draftUpdate?.[1]?.body))).toEqual({ draftId: 'draft-1', sourceCode: 'private String accountName;\n' })
    const saveCall = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/visualizer/maintained/') && init?.method === 'PUT')
    expect(JSON.parse(String(saveCall?.[1]?.body))).toMatchObject({ sourceCode: 'private String accountName;\n', reviewRationale: 'Verified the source and identifiers.' })
  })
})

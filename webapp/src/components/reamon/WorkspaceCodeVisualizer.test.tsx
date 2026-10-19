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
      <WorkspaceCodeVisualizer projectId="project-1" isAnalyzing={props.isAnalyzing ?? false} decompilationTask={props.decompilationTask} decompilationHref={props.decompilationHref} standalone={props.standalone} />
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

  test('navigates between completed decompilation runs', async () => {
    const requests: string[] = []
    const fetchMock = vi.fn((input: string) => {
      requests.push(input)
      const older = input.includes('taskId=run-old')
      return Promise.resolve({ ok: true, json: async () => ({
        units: [unit({ id: older ? 'older-unit' : 'latest-unit', name: older ? 'older.Main' : 'latest.Main' })],
        total: 1,
        hasMore: false,
        runs: [
          { id: 'run-new', title: 'Latest analysis', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z', artifactName: 'app.apk', codeUnitCount: 2, unitLabel: 'classes', discoveredUnitCount: 2, returnedUnitCount: 2, indexedUnitCount: 2, linkPercent: 100, codeBytes: 4096, truncated: false, warnings: '', failedUnitCount: null, visitedUnitCount: null },
          { id: 'run-old', title: 'Previous analysis', createdAt: '2026-10-03T00:00:00.000Z', completedAt: '2026-10-03T00:01:00.000Z', artifactName: 'app.apk', codeUnitCount: 1, unitLabel: 'classes', discoveredUnitCount: 1, returnedUnitCount: 1, indexedUnitCount: 1, linkPercent: 100, codeBytes: 2048, truncated: false, warnings: '', failedUnitCount: null, visitedUnitCount: null },
        ],
        selectedRunId: older ? 'run-old' : 'run-new',
      }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()
    const history = await screen.findByRole('navigation', { name: 'Analysis run history' })

    expect(history).toHaveTextContent('Run 1 of 2')
    fireEvent.click(screen.getByRole('button', { name: 'Previous run' }))
    await waitFor(() => expect(requests).toContain('/api/projects/project-1/visualizer?taskId=run-old'))
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Analysis run history' })).toHaveTextContent('Run 2 of 2'))
    expect(await screen.findByRole('button', { name: /older\.Main/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Latest run' }))
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Analysis run history' })).toHaveTextContent('Run 1 of 2'))
    expect(requests.filter((request) => request === '/api/projects/project-1/visualizer')).toHaveLength(1)
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
    expect(screen.getByRole('link', { name: 'Run decompilation again' })).toHaveAttribute('href', '#analysis-next-step')
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
  test('offers a direct route to decompilation when an artifact is ready but has no code units', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units: [], total: 0, hasMore: false }) }))
    renderVisualizer({ decompilationHref: '#analysis-next-step' })

    expect(await screen.findByText('No code units have been analyzed yet.')).toBeInTheDocument()
    expect(screen.getByText(/Run a compatible analyzer to populate this map/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Run decompilation' })).toHaveAttribute('href', '#analysis-next-step')
  })

  test('shows a running state instead of the empty-result prompt while analysis is active', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units: [], total: 0, hasMore: false }) }))
    renderVisualizer({ isAnalyzing: true, decompilationTask: { status: 'RUNNING', progressMessage: 'Indexing Java source 3 of 10' }, decompilationHref: '#analysis-next-step' })

    expect(await screen.findByText('Decompilation is running.')).toBeInTheDocument()
    expect(screen.getByText('Indexing Java source 3 of 10')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Run decompilation' })).not.toBeInTheDocument()
  })

  test('sends queued and approval-blocked runs to task controls', async () => {
    for (const [status, label] of [
      ['QUEUED', 'Decompilation is queued.'],
      ['AWAITING_APPROVAL', 'Decompilation is waiting for approval.'],
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
    expect(await screen.findByRole('button', { name: 'Explain selected code' })).toBeInTheDocument()
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units: [unit({ unitType: 'class' })], total: 1, hasMore: false }) }))
    renderVisualizer()

    expect(await screen.findByRole('button', { name: /app\.MainActivity\.onCreate/ })).toBeInTheDocument()
    const contents = screen.getByRole('group', { name: 'Treemap contents' })
    expect(within(contents).getByRole('button', { name: 'Code units' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(contents).getByRole('button', { name: 'Packages' }))

    expect(await screen.findByRole('button', { name: /app package/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /app\.MainActivity\.onCreate/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /app package/ }))
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
    expect(await screen.findByText('Reverse engineer one method at a time')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create maintainable version' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /method a · line 1/ }))

    expect(await screen.findByRole('textbox', { name: 'Editable maintained source' })).toHaveValue(source.replace(method, 'public String a() { return "x".trim(); }'))
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units, total: 2, hasMore: false }) }))
    renderVisualizer()
    fireEvent.click(await screen.findByRole('button', { name: 'Treemap' }))
    openDetails('Map options')

    const maintainedTile = await screen.findByRole('button', { name: /app\.Ready/ })
    const pendingTile = await screen.findByRole('button', { name: /app\.Pending/ })
    expect(maintainedTile.querySelector('rect')).toHaveAttribute('fill', 'var(--status-success, #00a876)')
    expect(pendingTile.querySelector('rect')).toHaveAttribute('fill', 'var(--status-warning, #b99a3b)')

    const layers = screen.getByRole('group', { name: 'Treemap color layer' })
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

  test('opens a Ghidra callee from the call graph even when it is outside the loaded treemap page', async () => {
    const main = unit({
      id: 'native-main', name: 'main', address: '0x1000', language: 'C', unitType: 'function', source: 'reamon-ghidra',
      codeArtifactId: 'project-1/artifact-1/native-run/sources/main.c',
    })
    const helper = unit({
      id: 'native-helper', name: 'helper', address: '0x1080', language: 'C', unitType: 'function', source: 'reamon-ghidra',
      codeArtifactId: 'project-1/artifact-1/native-run/sources/helper.c',
    })
    const run = { id: 'native-run', title: 'Ghidra run', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z', artifactName: 'program', codeUnitCount: 2, unitLabel: 'functions', discoveredUnitCount: 2, returnedUnitCount: 2, indexedUnitCount: 2, linkPercent: 100, codeBytes: 2048, truncated: false, warnings: '', failedUnitCount: null, visitedUnitCount: 2 }
    const fetchMock = vi.fn((input: string) => {
      if (input.includes('/visualizer/callgraph')) {
        const helperFocus = input.includes('unitId=native-helper')
        return Promise.resolve({
          ok: true,
          json: async () => helperFocus
            ? { focusKey: 'key-helper', nodes: [{ key: 'key-helper', label: 'helper', address: '0x1080', codeUnit: helper, isFocus: true }], edges: [], truncated: false }
            : { focusKey: 'key-main', nodes: [
                { key: 'key-main', label: 'main', address: '0x1000', codeUnit: main, isFocus: true },
                { key: 'key-helper', label: 'helper', address: '0x1080', codeUnit: helper, isFocus: false },
              ], edges: [{ id: 'edge-main-helper', fromKey: 'key-main', toKey: 'key-helper', label: 'main calls helper' }], truncated: false },
        })
      }
      if (input.includes('/visualizer/providers')) return Promise.resolve({ ok: true, json: async () => ({ providers: [] }) })
      if (input.includes('/decompiled/')) return Promise.resolve({ ok: true, text: async () => 'return 7;' })
      return Promise.resolve({ ok: true, json: async () => ({ units: [main], total: 2, hasMore: true, nextCursor: 'native-main', runs: [run], selectedRunId: 'native-run' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: /main,/ }))
    const graph = await screen.findByRole('region', { name: 'Function call graph' })
    fireEvent.click(await within(graph).findByRole('button', { name: 'Open function helper' }))

    expect(await screen.findByText('Selected code unit')).toBeInTheDocument()
    expect(screen.getAllByText('helper').length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.getByRole('region', { name: 'Decompiled source' }).querySelector('code')?.textContent).toContain('return 7;'))
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/visualizer/callgraph?taskId=native-run&unitId=native-helper'), expect.any(Object))
  })

  test('shows Android class dependencies from the selected JADX run', async () => {
    const main = unit({ id: 'android-main', name: 'app.Main', unitType: 'class', source: 'reamon-jadx' })
    const helper = unit({ id: 'android-helper', name: 'app.Helper', unitType: 'class', source: 'reamon-jadx' })
    const run = { id: 'android-run', title: 'JADX run', createdAt: '2026-10-04T00:00:00.000Z', completedAt: '2026-10-04T00:01:00.000Z', artifactName: 'app.apk', providerId: 'reamon-jadx', codeUnitCount: 2, unitLabel: 'classes', discoveredUnitCount: 2, returnedUnitCount: 2, indexedUnitCount: 2, linkPercent: 100, codeBytes: 2048, truncated: false, warnings: '', failedUnitCount: null, visitedUnitCount: null }
    const fetchMock = vi.fn((input: string) => {
      if (input.includes('/visualizer/callgraph')) return Promise.resolve({ ok: true, json: async () => ({
        graphType: 'class_dependencies', focusKey: 'key-main', truncated: false,
        nodes: [
          { key: 'key-main', label: 'app.Main', address: null, codeUnit: main, isFocus: true },
          { key: 'key-helper', label: 'app.Helper', address: null, codeUnit: helper, isFocus: false },
        ],
        edges: [{ id: 'main-helper', fromKey: 'key-main', toKey: 'key-helper', label: 'depends on' }],
      }) })
      if (input.includes('/visualizer/coverage')) return Promise.resolve({ ok: true, json: async () => ({ taskId: 'android-run', codeUnitCount: 2, maintainedUnitCount: 0, coveragePercent: 0, decompilationCoveragePercent: 100, sourceLinkedPercent: 100, codeBytes: 2048, measuredBytes: 2048 }) })
      return Promise.resolve({ ok: true, json: async () => ({ units: [main], total: 2, hasMore: false, runs: [run], selectedRunId: 'android-run' }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: 'Class dependencies' }))

    expect(await screen.findByRole('heading', { name: 'Program class dependencies' })).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Program class dependency graph' })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/visualizer/callgraph?taskId=android-run&view=graph', expect.any(Object))
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
    fireEvent.click(screen.getByRole('button', { name: 'Save maintained copy' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Maintained (1)' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /app\.Second.*maintained source saved/ })).toBeInTheDocument()
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
    else delete (HTMLElement.prototype as HTMLElement & { scrollIntoView?: () => void }).scrollIntoView
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
    const fetchMock = vi.fn((input: string) => {
      if (input.includes('/disassembly/')) return Promise.resolve({ ok: true, text: async () => '.method public onCreate()V\n    return-void\n.end method' })
      if (input.includes('/decompiled/')) return Promise.resolve({ ok: true, text: async () => 'public class MainActivity {}' })
      return Promise.resolve({ ok: true, json: async () => ({ units: [android], total: 1, hasMore: false }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderVisualizer()

    fireEvent.click(await screen.findByRole('button', { name: 'Packages' }))
    fireEvent.click(await screen.findByRole('button', { name: /com package/ }))
    fireEvent.click(await screen.findByRole('button', { name: /example package/ }))
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
    expect(screen.getByRole('button', { name: 'Save maintained copy' })).toBeDisabled()
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
    fireEvent.click(screen.getByRole('button', { name: 'Save maintained copy' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Maintained copy saved separately'))
    const transformCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/visualizer/deobfuscate'))
    expect(JSON.parse(String(transformCall?.[1]?.body))).toMatchObject({ unitId: 'unit-1', providerId: 'provider-local' })
    const draftCreate = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/visualizer/drafts/') && init?.method === 'POST')
    expect(JSON.parse(String(draftCreate?.[1]?.body))).toMatchObject({ sourceCode: 'private String accountName;', providerName: 'Local Qwen', model: 'Qwen3.5-0.8B', scope: 'file', syntaxValidated: true })
    const draftUpdate = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/visualizer/drafts/') && init?.method === 'PATCH')
    expect(JSON.parse(String(draftUpdate?.[1]?.body))).toEqual({ draftId: 'draft-1', sourceCode: 'private String accountName;\n' })
    const saveCall = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/visualizer/maintained/') && init?.method === 'PUT')
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({ sourceCode: 'private String accountName;\n' })
  })
})

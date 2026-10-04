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

function renderVisualizer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceCodeVisualizer projectId="project-1" isAnalyzing={false} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('WorkspaceCodeVisualizer', () => {
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

  test('states that no code units are available before an analyzer publishes them', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ units: [], total: 0, hasMore: false }) }))
    renderVisualizer()

    expect(await screen.findByText('No code units have been analyzed yet.')).toBeInTheDocument()
    expect(screen.getByText(/An analyzer must publish functions or other code units/)).toBeInTheDocument()
  })

  test('filters, selects a code unit, and links to its stored code artifact', async () => {
    const units = [unit(), unit({ id: 'unit-2', name: 'app.MainActivity.onPause', sizeBytes: 2048 })]
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

    expect(await screen.findByText('Selected code unit')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open code separately' })).toHaveAttribute('href', '/api/projects/project-1/artifacts/artifact-1/decompiled/project-1/artifact-1/task-1/run-1/sources/app/MainActivity.java')
    expect(await screen.findByText(/saveState\(\);/)).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Explain selected code' })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await waitFor(() => expect(screen.queryByRole('button', { name: /app\.MainActivity\.onCreate/ })).toBeNull())
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
    fireEvent.click(screen.getByRole('button', { name: 'Load more code units' }))

    expect(await screen.findByRole('button', { name: /app\.second/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more code units' })).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/visualizer?taskId=run-new&cursor=unit-first', expect.objectContaining({ cache: 'no-store' }))
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
    expect(await within(comparison).findByText(/MOV RBP, RSP/)).toBeInTheDocument()
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
})

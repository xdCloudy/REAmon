import { beforeEach, describe, expect, test, vi } from 'vitest'
import { runWorkspaceImport, selectionFromFiles, WorkspaceImportCancelledError, type BrowserWorkspaceFile } from './browser-import'

function browserFile(relativePath: string, contents = 'bytes'): BrowserWorkspaceFile {
  const name = relativePath.split('/').pop() || relativePath
  const file = new File([contents], name, { type: 'application/octet-stream', lastModified: 1790872012000 }) as BrowserWorkspaceFile
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  return file
}

describe('browser workspace imports', () => {
  beforeEach(() => vi.restoreAllMocks())

  test('keeps same filenames distinct by relative path', () => {
    const selection = selectionFromFiles([
      browserFile('Example/bin/x64/foo.dll'),
      browserFile('Example/bin/x86/foo.dll'),
      browserFile('Example/plugins/foo.dll'),
    ])
    expect(selection.rootName).toBe('Example')
    expect(selection.files.map((entry) => entry.relativePath)).toEqual([
      'bin/x64/foo.dll',
      'bin/x86/foo.dll',
      'plugins/foo.dll',
    ])
  })

  test('rejects a selection that escapes its browser folder root', () => {
    expect(() => selectionFromFiles([browserFile('Example/../outside.bin')])).toThrow(/relative path|traversal/i)
  })

  test('creates an import, retries a failed upload, and finalizes deterministically', async () => {
    const selection = selectionFromFiles([browserFile('Example/bin/app.exe', 'app'), browserFile('Example/config.json', '{}')])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'import-1' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'temporary failure' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ receivedBytes: 3 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ artifactId: 'a1' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ receivedBytes: 2 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ artifactId: 'a2' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const phases: string[] = []

    const result = await runWorkspaceImport({
      projectId: 'project-1',
      selection,
      concurrency: 1,
      onProgress: (progress) => phases.push(progress.phase),
    })

    expect(result).toEqual({ importId: 'import-1', failedPaths: [] })
    expect(fetchMock).toHaveBeenCalledTimes(7)
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url), window.location.origin))
    expect(urls.map(({ pathname }) => pathname)).toEqual([
      '/api/projects/project-1/imports',
      '/api/projects/project-1/imports/import-1/artifacts/chunks',
      '/api/projects/project-1/imports/import-1/artifacts/chunks',
      '/api/projects/project-1/imports/import-1/artifacts/complete',
      '/api/projects/project-1/imports/import-1/artifacts/chunks',
      '/api/projects/project-1/imports/import-1/artifacts/complete',
      '/api/projects/project-1/imports/import-1/finalize',
    ])
    expect(urls.slice(1, 3).map((url) => url.searchParams.get('relativePath'))).toEqual(['bin/app.exe', 'bin/app.exe'])
    expect(urls[4].searchParams.get('relativePath')).toBe('config.json')
    expect(phases.at(-1)).toBe('COMPLETED')
  })

  test('preserves the import ID and reports failure when finalization fails', async () => {
    const selection = selectionFromFiles([browserFile('Example/src/main.c', 'source')])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'import-1' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ receivedBytes: 6 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ artifact: { id: 'artifact-1' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Inventory save failed' }), { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const phases: string[] = []
    const onImportReady = vi.fn()

    await expect(runWorkspaceImport({
      projectId: 'project-1',
      selection,
      onImportReady,
      onProgress: (progress) => phases.push(progress.phase),
    })).rejects.toThrow('Inventory save failed')

    expect(onImportReady).toHaveBeenCalledWith('import-1')
    expect(phases.slice(-2)).toEqual(['FINALIZING', 'FAILED'])
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe('/api/projects/project-1/imports/import-1/finalize')
  })

  test('marks failed inventory preparation in progress instead of leaving it at zero percent', async () => {
    const selection = selectionFromFiles([browserFile('Example/src/main.c', 'source')])
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Inventory unavailable' }), { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const phases: string[] = []

    await expect(runWorkspaceImport({
      projectId: 'project-1',
      selection,
      onProgress: (progress) => phases.push(progress.phase),
    })).rejects.toThrow('Inventory unavailable')

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(phases).toEqual(['INVENTORY', 'FAILED'])
  })

  test('aborts a pending inventory preparation and reports cancellation', async () => {
    const selection = selectionFromFiles([browserFile('Example/src/main.c', 'source')])
    const controller = new AbortController()
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal)
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    vi.stubGlobal('fetch', fetchMock)
    const phases: string[] = []

    await expect(runWorkspaceImport({
      projectId: 'project-1',
      selection,
      signal: controller.signal,
      onProgress: (progress) => phases.push(progress.phase),
    })).rejects.toBeInstanceOf(WorkspaceImportCancelledError)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(phases).toEqual(['INVENTORY', 'CANCELLED'])
  })

  test('stops queued uploads when the operator aborts the snapshot', async () => {
    const selection = selectionFromFiles([
      browserFile('Example/one.bin', '1'),
      browserFile('Example/two.bin', '2'),
    ])
    const controller = new AbortController()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'import-1' }), { status: 201 }))
      .mockImplementationOnce(async () => {
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      })
    vi.stubGlobal('fetch', fetchMock)

    await expect(runWorkspaceImport({
      projectId: 'project-1',
      selection,
      concurrency: 1,
      signal: controller.signal,
    })).rejects.toBeInstanceOf(WorkspaceImportCancelledError)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toContain('/imports/import-1/artifacts')
  })
})

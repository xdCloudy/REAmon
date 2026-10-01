import { beforeEach, describe, expect, test, vi } from 'vitest'
import { runWorkspaceImport, selectionFromFiles, type BrowserWorkspaceFile } from './browser-import'

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
      .mockResolvedValueOnce(new Response(JSON.stringify({ artifactId: 'a1' }), { status: 201 }))
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
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/projects/project-1/imports',
      '/api/projects/project-1/imports/import-1/artifacts',
      '/api/projects/project-1/imports/import-1/artifacts',
      '/api/projects/project-1/imports/import-1/artifacts',
      '/api/projects/project-1/imports/import-1/finalize',
    ])
    expect(phases.at(-1)).toBe('COMPLETED')
  })
})

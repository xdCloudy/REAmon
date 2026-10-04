/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  runWorkspaceImport: vi.fn(),
  selectionFromFiles: vi.fn(),
}))

vi.mock('@/lib/reamon/browser-import', () => ({
  formatBytes: (bytes: number) => `${bytes} bytes`,
  runWorkspaceImport: mocks.runWorkspaceImport,
  selectionFromFiles: mocks.selectionFromFiles,
  WorkspaceImportCancelledError: class extends Error {},
}))

import { WorkspaceImportPanel } from './WorkspaceImportPanel'

const selection = {
  rootName: 'app.apk',
  files: [{ file: new File(['a'], 'app.apk'), relativePath: 'app.apk', size: 1, lastModified: 1 }],
  totalBytes: 1,
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('WorkspaceImportPanel', () => {
  test('distinguishes completed file transfer from reverse-engineering progress', async () => {
    mocks.selectionFromFiles.mockReturnValue(selection)
    mocks.runWorkspaceImport.mockImplementation(async (options: { onProgress?: (value: unknown) => void }) => {
      options.onProgress?.({
        phase: 'COMPLETED', completedFiles: 1, totalFiles: 1,
        uploadedBytes: 1, totalBytes: 1, currentPath: '', failedPaths: [],
      })
      return { importId: 'import-1', failedPaths: [] }
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ comparison: null, limits: { maxFiles: 10, maxImportBytes: 100, maxArtifactBytes: 50 } }),
    }))
    render(<WorkspaceImportPanel projectId="project-1" onImported={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Add files'), { target: { files: [new File(['a'], 'app.apk')] } })
    fireEvent.click(screen.getByRole('button', { name: 'Import workspace' }))

    const transfer = await screen.findByRole('progressbar', { name: 'Workspace file transfer' })
    expect(transfer).toHaveAttribute('aria-valuenow', '100')
    expect(transfer).toHaveAttribute('aria-valuetext', '100% of selected files transferred; analysis is tracked separately')
    expect(await screen.findByText('Import complete. Analysis is a separate step.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to analysis actions' })).toHaveAttribute('href', '#analysis-next-step')
  })
})

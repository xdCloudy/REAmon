/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkspaceImportCancelledError } from '@/lib/reamon/browser-import'

const mocks = vi.hoisted(() => ({
  runWorkspaceImport: vi.fn(),
  selectionFromFiles: vi.fn(),
}))

vi.mock('@/lib/reamon/browser-import', () => ({
  formatBytes: (bytes: number) => `${bytes} bytes`,
  runWorkspaceImport: mocks.runWorkspaceImport,
  selectionFromFiles: mocks.selectionFromFiles,
  WorkspaceImportCancelledError: class extends Error {
    readonly importId?: string
    constructor(importId?: string) {
      super('Workspace import cancelled')
      this.importId = importId
    }
  },
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
  vi.resetAllMocks()
})

describe('WorkspaceImportPanel', () => {
  test('shows shared artifact storage capacity as an advisory', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ storage: {
        available: true, totalBytes: '100', usedBytes: '95', freeBytes: '5', usedPercent: 95, checkedAt: '2026-10-25T00:00:00.000Z',
      } }),
    }))
    render(<WorkspaceImportPanel projectId="project-1" onImported={vi.fn()} />)

    expect(await screen.findByRole('status')).toHaveTextContent('Shared artifact storage: 95 bytes used of 100 bytes · 5 bytes available.')
    expect(screen.getByRole('status')).toHaveTextContent('Storage is running low; imports or analysis may fail if the volume fills.')
  })

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

  test('keeps the import resumable when saving inventory fails after transfer', async () => {
    mocks.selectionFromFiles.mockReturnValue(selection)
    mocks.runWorkspaceImport
      .mockImplementationOnce(async (options: { onImportReady?: (id: string) => void; onProgress?: (value: unknown) => void }) => {
        options.onImportReady?.('import-1')
        options.onProgress?.({
          phase: 'FINALIZING', completedFiles: 1, totalFiles: 1,
          uploadedBytes: 1, totalBytes: 1, currentPath: '', failedPaths: [],
        })
        options.onProgress?.({
          phase: 'FAILED', completedFiles: 1, totalFiles: 1,
          uploadedBytes: 1, totalBytes: 1, currentPath: '', failedPaths: [],
        })
        throw new Error('Inventory save failed')
      })
      .mockImplementationOnce(async (options: { importId?: string }) => {
        expect(options.importId).toBe('import-1')
        return { importId: 'import-1', failedPaths: [] }
      })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ comparison: null, limits: { maxFiles: 10, maxImportBytes: 100, maxArtifactBytes: 50 } }),
    }))
    const onImported = vi.fn()
    render(<WorkspaceImportPanel projectId="project-1" onImported={onImported} />)

    fireEvent.change(screen.getByLabelText('Add files'), { target: { files: [new File(['a'], 'app.apk')] } })
    fireEvent.click(screen.getByRole('button', { name: 'Import workspace' }))

    expect(await screen.findByText('Import needs attention')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Workspace file transfer' })).toHaveAttribute('aria-valuetext', '100% of selected files transferred; the import needs attention')
    expect(await screen.findByRole('alert')).toHaveTextContent('Inventory save failed')
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed files' }))
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce())
    expect(mocks.runWorkspaceImport).toHaveBeenCalledTimes(2)
  })

  test('locks file selection while an import is busy', async () => {
    mocks.selectionFromFiles.mockReturnValue(selection)
    let finishImport!: (result: { importId: string; failedPaths: string[] }) => void
    mocks.runWorkspaceImport
      .mockImplementationOnce((options: { onImportReady?: (id: string) => void; onProgress?: (value: unknown) => void }) => {
        options.onImportReady?.('import-1')
        options.onProgress?.({
          phase: 'UPLOADING', completedFiles: 0, totalFiles: 1,
          uploadedBytes: 0, totalBytes: 1, currentPath: 'app.apk', failedPaths: [],
        })
        return new Promise((resolve) => { finishImport = resolve })
      })
      .mockImplementationOnce(async (options: { importId?: string }) => {
        expect(options.importId).toBe('import-1')
        return { importId: 'import-1', failedPaths: [] }
      })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ comparison: null }) })
    vi.stubGlobal('fetch', fetchMock)
    const onImported = vi.fn()
    render(<WorkspaceImportPanel projectId="project-1" onImported={onImported} />)

    fireEvent.change(screen.getByLabelText('Add files'), { target: { files: [new File(['a'], 'app.apk')] } })
    fireEvent.click(screen.getByRole('button', { name: 'Import workspace' }))

    const filePicker = screen.getByLabelText('Add files') as HTMLInputElement
    await waitFor(() => expect(filePicker).toBeDisabled())
    fireEvent.change(filePicker, { target: { files: [new File(['b'], 'other.bin')] } })
    expect(mocks.selectionFromFiles).toHaveBeenCalledTimes(1)
    expect(screen.getAllByText('app.apk')).toHaveLength(2)

    finishImport!({ importId: 'import-1', failedPaths: [] })
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce())
  })

  test('resumes the same import after cancellation', async () => {
    mocks.selectionFromFiles.mockReturnValue(selection)
    mocks.runWorkspaceImport
      .mockImplementationOnce(async (options: { onImportReady?: (id: string) => void }) => {
        options.onImportReady?.('import-1')
        throw new WorkspaceImportCancelledError('import-1')
      })
      .mockImplementationOnce(async (options: { importId?: string }) => {
        expect(options.importId).toBe('import-1')
        return { importId: 'import-1', failedPaths: [] }
      })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ comparison: null }) })
    vi.stubGlobal('fetch', fetchMock)
    const onImported = vi.fn()
    render(<WorkspaceImportPanel projectId="project-1" onImported={onImported} />)

    fireEvent.change(screen.getByLabelText('Add files'), { target: { files: [new File(['a'], 'app.apk')] } })
    fireEvent.click(screen.getByRole('button', { name: 'Import workspace' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Import cancelled. Resume it to continue uploading the remaining paths.')
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/imports/import-1/cancel', { method: 'POST' })
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed files' }))
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce())
  })

  test('explains that setup must restart when cancellation happened before an import ID existed', async () => {
    mocks.selectionFromFiles.mockReturnValue(selection)
    mocks.runWorkspaceImport.mockRejectedValueOnce(new WorkspaceImportCancelledError())
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ comparison: null }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<WorkspaceImportPanel projectId="project-1" onImported={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Add files'), { target: { files: [new File(['a'], 'app.apk')] } })
    fireEvent.click(screen.getByRole('button', { name: 'Import workspace' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Import cancelled before setup completed. Start the import again to retry.')
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/cancel'), expect.anything())
  })
})

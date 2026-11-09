/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProjectGoBuild } from './ProjectGoBuild'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ProjectGoBuild', () => {
  test('builds the selected run and displays a hash-bound multi-package receipt', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ receipt: null }) }).mockResolvedValue({
      ok: true,
      json: async () => ({ receipt: {
        sourceSha256: 'a'.repeat(64),
        dependencySha256: 'b'.repeat(64),
        validationStatus: 'PASSED',
        validationMethod: 'go-1.24-project-build',
        validationMessage: 'Compiled two reviewed files across two packages without executing them.',
        compiledSha256: 'c'.repeat(64),
        packageCount: 2,
        files: [
          { relativePath: 'core/value.go', sourceSha256: 'd'.repeat(64), acceptedReviewId: 'review-1' },
          { relativePath: 'app/main.go', sourceSha256: 'e'.repeat(64), acceptedReviewId: 'review-2' },
        ],
        dependencies: [{ relativePath: 'go.mod', sourceSha256: 'f'.repeat(64) }],
      } }),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectGoBuild projectId="project-1" taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Build accepted Go files' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Go project build passed · 2 files · 2 packages · receipt aaaaaaaaaaaa')
    expect(screen.getByRole('status')).toHaveTextContent('1 dependency manifest verified')
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/visualizer/maintained/go-project-build', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1' }),
    }))
  })

  test('surfaces offline dependency resolution as an actionable error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ receipt: null }) }).mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'An imported Go module dependency is unavailable offline.' }),
    }))
    render(<ProjectGoBuild projectId="project-1" taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Build accepted Go files' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('An imported Go module dependency is unavailable offline.')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('restores a saved receipt for the selected run', async () => {
    const receipt = {
      sourceSha256: 'e'.repeat(64),
      dependencySha256: 'f'.repeat(64),
      validationStatus: 'FAILED' as const,
      validationMethod: 'go-1.24-project-build',
      validationMessage: 'Go rejected the package.',
      compiledSha256: null,
      packageCount: 1,
      files: [{ relativePath: 'main.go', sourceSha256: 'a'.repeat(64), acceptedReviewId: 'review-1' }],
      dependencies: [],
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ receipt }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectGoBuild projectId="project 1" taskId="task 1" />)

    expect(await screen.findByRole('status')).toHaveTextContent('Go project build failed · 1 file · 1 package · receipt eeeeeeeeeeee')
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project%201/visualizer/maintained/go-project-build?taskId=task%201')
  })

  test('does not show an older run receipt after the selected run changes', async () => {
    const oldBuildReceipt = {
      sourceSha256: 'a'.repeat(64),
      dependencySha256: 'b'.repeat(64),
      validationStatus: 'PASSED' as const,
      validationMethod: 'go-1.24-project-build',
      validationMessage: 'Old run build completed.',
      compiledSha256: 'c'.repeat(64),
      packageCount: 1,
      files: [{ relativePath: 'main.go', sourceSha256: 'd'.repeat(64), acceptedReviewId: 'review-old' }],
      dependencies: [],
    }
    const selectedRunReceipt = {
      ...oldBuildReceipt,
      sourceSha256: 'e'.repeat(64),
      validationMessage: 'Selected run build completed.',
      files: [{ relativePath: 'main.go', sourceSha256: 'f'.repeat(64), acceptedReviewId: 'review-new' }],
    }
    let resolveOldBuild!: (value: { ok: boolean; json: () => Promise<{ receipt: typeof oldBuildReceipt }> }) => void
    const pendingOldBuild = new Promise<{ ok: boolean; json: () => Promise<{ receipt: typeof oldBuildReceipt }> }>((resolve) => {
      resolveOldBuild = resolve
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ receipt: null }) })
      .mockReturnValueOnce(pendingOldBuild)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ receipt: selectedRunReceipt }) })
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<ProjectGoBuild projectId="project-1" taskId="task-old" />)

    fireEvent.click(screen.getByRole('button', { name: 'Build accepted Go files' }))
    rerender(<ProjectGoBuild projectId="project-1" taskId="task-new" />)

    expect(await screen.findByRole('status')).toHaveTextContent('receipt eeeeeeeeeeee')
    await act(async () => {
      resolveOldBuild({ ok: true, json: async () => ({ receipt: oldBuildReceipt }) })
      await pendingOldBuild
    })

    expect(screen.getByRole('status')).toHaveTextContent('Selected run build completed.')
    expect(screen.getByRole('status')).not.toHaveTextContent('Old run build completed.')
  })
})

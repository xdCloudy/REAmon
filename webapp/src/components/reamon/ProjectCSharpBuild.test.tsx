/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProjectCSharpBuild } from './ProjectCSharpBuild'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ProjectCSharpBuild', () => {
  test('builds the selected run and displays a hash-bound receipt', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ receipt: null }) }).mockResolvedValue({
      ok: true,
      json: async () => ({ receipt: {
        sourceSha256: 'a'.repeat(64),
        validationStatus: 'PASSED',
        validationMethod: 'roslyn-csharp-project-4.11.0-compile',
        validationMessage: 'Roslyn compiled two files together without executing them.',
        compiledSha256: 'b'.repeat(64),
        files: [
          { relativePath: 'Core/Pair.cs', sourceSha256: 'c'.repeat(64), acceptedReviewId: 'review-1' },
          { relativePath: 'App/Runner.cs', sourceSha256: 'd'.repeat(64), acceptedReviewId: 'review-2' },
        ],
      } }),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectCSharpBuild projectId="project-1" taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Build accepted C# files' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Project build passed · 2 files · receipt aaaaaaaaaaaa')
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/visualizer/maintained/project-build', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ taskId: 'task-1' }),
    }))
  })

  test('keeps compiler failures distinct from request errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ receipt: null }) }).mockResolvedValue({
      ok: true,
      json: async () => ({ receipt: {
        sourceSha256: 'a'.repeat(64),
        validationStatus: 'FAILED',
        validationMethod: 'roslyn-csharp-project-4.11.0-compile',
        validationMessage: 'Pair was not found.',
        compiledSha256: null,
        files: [{ relativePath: 'App/Runner.cs', sourceSha256: 'c'.repeat(64), acceptedReviewId: 'review-1' }],
      } }),
    }))
    render(<ProjectCSharpBuild projectId="project-1" taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: 'Build accepted C# files' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Project build failed · 1 file')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('restores a saved receipt for the selected run', async () => {
    const receipt = {
      sourceSha256: 'e'.repeat(64),
      validationStatus: 'PASSED' as const,
      validationMethod: 'roslyn-csharp-project-4.11.0-compile',
      validationMessage: 'Compiled without executing.',
      compiledSha256: 'f'.repeat(64),
      files: [{ relativePath: 'Core/Pair.cs', sourceSha256: 'a'.repeat(64), acceptedReviewId: 'review-1' }],
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ receipt }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<ProjectCSharpBuild projectId="project 1" taskId="task 1" />)

    expect(await screen.findByRole('status')).toHaveTextContent('Project build passed · 1 file · receipt eeeeeeeeeeee')
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project%201/visualizer/maintained/project-build?taskId=task%201')
  })
})

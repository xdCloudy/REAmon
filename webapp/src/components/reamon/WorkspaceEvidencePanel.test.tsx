/** @vitest-environment jsdom */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkspaceEvidencePanel } from './WorkspaceEvidencePanel'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function response(body: unknown) {
  return { ok: true, json: async () => body }
}

const record = {
  id: 'evidence-1', targetId: 'target-1', artifactId: 'artifact-1', kind: 'Function',
  summary: 'Recovered function body', summaryTruncated: false, source: 'ghidra', createdAt: '2026-11-09T10:00:00.000Z',
}

describe('WorkspaceEvidencePanel', () => {
  test('loads persisted evidence scoped to the selected artifact', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ evidence: [record], total: 1, hasMore: false, nextCursor: null }))
    vi.stubGlobal('fetch', fetchMock)
    render(<WorkspaceEvidencePanel projectId="project-1" artifactId="artifact-1" />)

    expect(await screen.findByText('Recovered function body')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/workspace/evidence?artifactId=artifact-1&limit=10', expect.anything())
  })

  test('continues the stable evidence cursor and appends the next page', async () => {
    const secondRecord = { ...record, id: 'evidence-2', summary: 'Recovered call reference' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ evidence: [record], total: 2, hasMore: true, nextCursor: 'cursor-2' }))
      .mockResolvedValueOnce(response({ evidence: [secondRecord], total: 2, hasMore: false, nextCursor: null }))
    vi.stubGlobal('fetch', fetchMock)
    render(<WorkspaceEvidencePanel projectId="project-1" artifactId="artifact-1" />)

    fireEvent.click(await screen.findByRole('button', { name: /Load more evidence/ }))
    expect(await screen.findByText('Recovered call reference')).toBeInTheDocument()
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=cursor-2')
  })

  test('appends detail bytes with the evidence hash and returned byte offset', async () => {
    const hash = 'a'.repeat(64)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ evidence: [record], total: 1, hasMore: false, nextCursor: null }))
      .mockResolvedValueOnce(response({ evidenceHash: hash, totalBytes: 12, detailsJson: '{"summary":', nextOffsetBytes: 10, hasMore: true }))
      .mockResolvedValueOnce(response({ evidenceHash: hash, totalBytes: 12, detailsJson: '"ok"}', nextOffsetBytes: 12, hasMore: false }))
    vi.stubGlobal('fetch', fetchMock)
    render(<WorkspaceEvidencePanel projectId="project-1" artifactId="artifact-1" />)

    fireEvent.click(await screen.findByRole('button', { name: /Recovered function body/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Load next detail page' }))

    await waitFor(() => expect(screen.getByLabelText('Evidence JSON')).toHaveTextContent('{"summary":"ok"}'))
    const continuation = new URL(String(fetchMock.mock.calls[2][0]), 'http://localhost')
    expect(continuation.searchParams.get('offsetBytes')).toBe('10')
    expect(continuation.searchParams.get('evidenceHash')).toBe(hash)
  })
})

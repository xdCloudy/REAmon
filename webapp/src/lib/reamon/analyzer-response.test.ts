import { describe, expect, test, vi } from 'vitest'
import { readAnalyzerResponse } from './analyzer-response'

describe('readAnalyzerResponse', () => {
  test('reads streamed analyzer phases before its final result', async () => {
    const response = new Response([
      JSON.stringify({ type: 'progress', message: 'Decompiling with JADX' }),
      JSON.stringify({ type: 'progress', message: 'Indexing Java source 2 of 5' }),
      JSON.stringify({ type: 'result', data: { status: 'completed', returnedUnits: 5 } }),
    ].join('\n'), { headers: { 'Content-Type': 'application/x-ndjson' } })
    const reportProgress = vi.fn()

    await expect(readAnalyzerResponse(response, reportProgress)).resolves.toEqual({ status: 'completed', returnedUnits: 5 })
    expect(reportProgress).toHaveBeenNthCalledWith(1, 'Decompiling with JADX')
    expect(reportProgress).toHaveBeenNthCalledWith(2, 'Indexing Java source 2 of 5')
  })

  test('surfaces analyzer failures sent after a streaming response starts', async () => {
    const response = new Response(JSON.stringify({ type: 'error', error: 'Ghidra could not analyze this binary' }), {
      headers: { 'Content-Type': 'application/x-ndjson' },
    })

    await expect(readAnalyzerResponse(response)).rejects.toThrow('Ghidra could not analyze this binary')
  })

  test('keeps JSON responses compatible with older analyzers', async () => {
    const response = new Response(JSON.stringify({ status: 'completed' }), { headers: { 'Content-Type': 'application/json' } })

    await expect(readAnalyzerResponse(response)).resolves.toEqual({ status: 'completed' })
  })

  test('accepts a bounded large decompiler result event', async () => {
    const result = { status: 'completed', sourceIndex: 'x'.repeat(1024 * 1024 + 1) }
    const response = new Response(JSON.stringify({ type: 'result', data: result }), {
      headers: { 'Content-Type': 'application/x-ndjson' },
    })

    await expect(readAnalyzerResponse(response)).resolves.toEqual(result)
  })

  test('reassembles bounded result chunks into the complete analyzer result', async () => {
    const response = new Response([
      JSON.stringify({ type: 'progress', message: 'Indexing source' }),
      JSON.stringify({ type: 'result_start', data: { status: 'completed', warnings: '' }, arrayFields: ['units', 'edges'] }),
      JSON.stringify({ type: 'result_chunk', field: 'units', items: [{ name: 'A' }, { name: 'B' }] }),
      JSON.stringify({ type: 'result_chunk', field: 'edges', items: [{ from: 'A', to: 'B' }] }),
      JSON.stringify({ type: 'result_end' }),
    ].join('\n'), { headers: { 'Content-Type': 'application/x-ndjson' } })

    await expect(readAnalyzerResponse(response)).resolves.toEqual({
      status: 'completed', warnings: '', units: [{ name: 'A' }, { name: 'B' }], edges: [{ from: 'A', to: 'B' }],
    })
  })

  test('rejects an incomplete chunked result instead of treating it as a completed analysis', async () => {
    const response = new Response([
      JSON.stringify({ type: 'result_start', data: { status: 'completed' }, arrayFields: ['units'] }),
      JSON.stringify({ type: 'result_chunk', field: 'units', items: [{ name: 'A' }] }),
    ].join('\n'), { headers: { 'Content-Type': 'application/x-ndjson' } })

    await expect(readAnalyzerResponse(response)).rejects.toThrow('Analyzer result stream ended before completion')
  })
})

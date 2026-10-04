const MAX_ANALYZER_EVENT_CHARS = 32 * 1024 * 1024
const MAX_ANALYZER_RESULT_ITEMS = 100_000

export async function readAnalyzerResponse<T>(
  response: Response,
  reportProgress?: (message: string) => Promise<void> | void,
): Promise<T> {
  if (!response.headers?.get('content-type')?.toLowerCase().includes('application/x-ndjson')) {
    return response.json() as Promise<T>
  }

  if (!response.body) throw new Error('Analyzer returned an empty progress stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: T | undefined
  let streamedResult: Record<string, unknown> | undefined
  let streamedItemCount = 0
  let streamedResultComplete = false
  let streamError: string | undefined

  async function consumeLine(line: string) {
    if (!line.trim()) return
    if (line.length > MAX_ANALYZER_EVENT_CHARS) throw new Error('Analyzer progress event exceeded the size limit')
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error('Analyzer returned an invalid progress event')
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return
    const record = event as Record<string, unknown>
    if (record.type === 'progress' && typeof record.message === 'string') {
      await reportProgress?.(record.message.slice(0, 500))
    } else if (record.type === 'result' && record.data && typeof record.data === 'object') {
      result = record.data as T
    } else if (record.type === 'result_start') {
      if (streamedResult || result || !record.data || typeof record.data !== 'object' || Array.isArray(record.data) || !Array.isArray(record.arrayFields)) {
        throw new Error('Analyzer returned an invalid result stream')
      }
      streamedResult = { ...(record.data as Record<string, unknown>) }
      const fields = new Set<string>()
      for (const field of record.arrayFields) {
        if (typeof field !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field) || Object.hasOwn(streamedResult, field) || fields.has(field)) {
          throw new Error('Analyzer returned an invalid result stream')
        }
        fields.add(field)
        streamedResult[field] = []
      }
    } else if (record.type === 'result_chunk') {
      const field = record.field
      const items = record.items
      if (!streamedResult || streamedResultComplete || typeof field !== 'string' || !Array.isArray(streamedResult[field]) || !Array.isArray(items)) {
        throw new Error('Analyzer returned an invalid result stream')
      }
      streamedItemCount += items.length
      if (streamedItemCount > MAX_ANALYZER_RESULT_ITEMS) throw new Error('Analyzer result exceeded the item limit')
      const target = streamedResult[field] as unknown[]
      for (const item of items) target.push(item)
    } else if (record.type === 'result_end') {
      if (!streamedResult || streamedResultComplete) throw new Error('Analyzer returned an invalid result stream')
      result = streamedResult as T
      streamedResultComplete = true
    } else if (record.type === 'error' && typeof record.error === 'string') {
      streamError = record.error.slice(0, 1200)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      if (buffer.length > MAX_ANALYZER_EVENT_CHARS && !buffer.includes('\n')) {
        throw new Error('Analyzer progress buffer exceeded the size limit')
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        await consumeLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      if (done) break
    }
    if (buffer.trim()) await consumeLine(buffer)
  } finally {
    reader.releaseLock()
  }
  if (streamError) throw new Error(streamError)
  if (streamedResult && !streamedResultComplete) throw new Error('Analyzer result stream ended before completion')
  if (result === undefined) throw new Error('Analyzer progress stream ended without a result')
  return result
}

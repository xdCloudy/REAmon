import { Prisma } from '@prisma/client'

const DEFAULT_MAX_RESULT_BYTES = 2 * 1024 * 1024
const MIN_MAX_RESULT_BYTES = 64 * 1024
const HARD_MAX_RESULT_BYTES = 8 * 1024 * 1024

function maxResultBytes(): number {
  const configured = Number.parseInt(process.env.REAMON_MAX_RESULT_BYTES || '', 10)
  if (!Number.isSafeInteger(configured) || configured <= 0) return DEFAULT_MAX_RESULT_BYTES
  return Math.min(HARD_MAX_RESULT_BYTES, Math.max(MIN_MAX_RESULT_BYTES, configured))
}

export interface BoundedResultSummary {
  _reamonTruncated: true
  originalBytes: number | null
  maxBytes: number
  reason: 'size' | 'non_json'
}

/**
 * Keep task/evidence JSON bounded even when a future provider returns a large
 * or non-serialisable payload. Raw data is still passed to observation parsing
 * before this value is persisted, so bounded normalized observations are not
 * lost merely because the provider envelope was too large.
 */
export function boundResultData(value: unknown): Prisma.InputJsonValue {
  const limit = maxResultBytes()
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    return { _reamonTruncated: true, originalBytes: null, maxBytes: limit, reason: 'non_json' } as unknown as Prisma.InputJsonValue
  }
  if (serialized === undefined) {
    return { _reamonTruncated: true, originalBytes: null, maxBytes: limit, reason: 'non_json' } as unknown as Prisma.InputJsonValue
  }

  const originalBytes = Buffer.byteLength(serialized, 'utf8')
  if (originalBytes <= limit) return JSON.parse(serialized) as Prisma.InputJsonValue
  return { _reamonTruncated: true, originalBytes, maxBytes: limit, reason: 'size' } as unknown as Prisma.InputJsonValue
}

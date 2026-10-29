import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'

const mocks = vi.hoisted(() => ({
  attemptFindMany: vi.fn(),
  attemptFindUnique: vi.fn(),
  attemptUpdateMany: vi.fn(),
  observationFindMany: vi.fn(),
  observationFindFirst: vi.fn(),
  transaction: vi.fn(),
  agentFetch: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  reamonCodeAttempt: { findMany: mocks.attemptFindMany, findUnique: mocks.attemptFindUnique, updateMany: mocks.attemptUpdateMany },
  reamonCodeUnitLease: { updateMany: vi.fn(), deleteMany: vi.fn() },
  reamonObservation: { findMany: mocks.observationFindMany, findFirst: mocks.observationFindFirst },
  $transaction: mocks.transaction,
} }))
vi.mock('@/lib/agentFetch', () => ({
  AgentUnreachableError: class AgentUnreachableError extends Error {},
  agentFetch: mocks.agentFetch,
}))

import { dispatchQueuedCodeRewrites } from './code-rewrite-jobs'

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

describe('manual investigation attempt dispatch', () => {
  const requestPayload = {
    model: 'custom/provider-1', user_id: 'user-1', unit_name: 'FUN_1000', artifact_sha256: 'a'.repeat(64),
    output_language: 'C', architecture: 'x86_64', assembly: 'push rbp\nret', control_flow: '', data_references: '',
    provider_evidence: [], question: 'Reconstruct conservatively.', investigationCaseId: 'case-1', taskId: 'task-1',
  }
  const sourceHash = createHash('sha256').update(stableJson(requestPayload)).digest('hex')
  const attempt = {
    id: 'attempt-1', projectId: 'project-1', artifactId: 'artifact-1', codeUnitId: 'investigation:case-1',
    scope: 'manual-investigation', status: 'QUEUED', requestPayload, timeoutMs: 30_000, unitLeaseId: null, sourceHash,
  }
  const txUpdateMany = vi.fn().mockResolvedValue({ count: 1 })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.attemptFindMany.mockImplementation(async ({ where }) => where.status === 'RUNNING' ? [] : [attempt])
    mocks.attemptFindUnique.mockResolvedValue(attempt)
    mocks.observationFindMany.mockResolvedValue([])
    mocks.observationFindFirst.mockResolvedValue(null)
    mocks.transaction.mockImplementation(async (callback) => callback({ reamonCodeAttempt: { updateMany: txUpdateMany } }))
    mocks.agentFetch.mockResolvedValue(new Response(JSON.stringify({
      candidate_status: 'GENERATED_CANDIDATE', source_code: 'int recovered(void) { return 0; }',
      source_sha256: createHash('sha256').update('int recovered(void) { return 0; }').digest('hex'),
      evidence_sha256: 'b'.repeat(64), uncertainties: ['The return value meaning is unknown.'], evidence_used: ['assembly'],
      syntax_validation: 'PASSED', behavioral_validation: 'UNAVAILABLE', exact_original_source_recovered: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  })

  test('dispatches the saved evidence and persists a hash-checked candidate as behaviorally unavailable', async () => {
    const result = await dispatchQueuedCodeRewrites({ limit: 1, workerId: 'test-worker' })

    expect(result.results).toEqual([{ attemptId: 'attempt-1', claimed: true }])
    expect(mocks.agentFetch).toHaveBeenCalledWith('/reamon/code/manual-decompile', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        model: 'custom/provider-1', user_id: 'user-1', unit_name: 'FUN_1000', artifact_sha256: 'a'.repeat(64),
        output_language: 'C', architecture: 'x86_64', assembly: 'push rbp\nret', control_flow: '', data_references: '',
        provider_evidence: [], question: 'Reconstruct conservatively.',
      }),
    }), expect.objectContaining({ timeoutMs: 30_000 }))
    expect(txUpdateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'attempt-1', status: 'RUNNING' }),
      data: expect.objectContaining({
        status: 'SUCCEEDED', resultSource: 'int recovered(void) { return 0; }', validationStatus: 'UNAVAILABLE',
        qualityReview: expect.objectContaining({
          candidateStatus: 'GENERATED_CANDIDATE', behavioralValidation: 'UNAVAILABLE', exactOriginalSourceRecovered: false,
          evidenceSha256: 'b'.repeat(64), uncertainties: ['The return value meaning is unknown.'],
        }),
      }),
    }))
  })

  test('refuses a queued attempt whose evidence no longer matches its saved hash', async () => {
    mocks.attemptFindUnique.mockResolvedValue({ ...attempt, sourceHash: 'f'.repeat(64) })

    const result = await dispatchQueuedCodeRewrites({ limit: 1, workerId: 'test-worker' })

    expect(result.results).toEqual([{ attemptId: 'attempt-1', claimed: true }])
    expect(mocks.agentFetch).not.toHaveBeenCalled()
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'attempt-1', status: 'RUNNING' }),
      data: expect.objectContaining({ status: 'FAILED', errorCode: 'request_integrity' }),
    }))
  })
})

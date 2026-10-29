import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  investigationFindFirst: vi.fn(),
  providerFindFirst: vi.fn(),
  caseLock: vi.fn(),
  attemptFindMany: vi.fn(),
  attemptCreate: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  $transaction: mocks.transaction,
  reamonInvestigationCase: { findFirst: mocks.investigationFindFirst },
  userLlmProvider: { findFirst: mocks.providerFindFirst },
  reamonCodeAttempt: { findMany: mocks.attemptFindMany, create: mocks.attemptCreate },
} }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: mocks.requireEffectiveUser, requireProjectAccess: mocks.requireProjectAccess }))

import { POST } from './route'

const params = Promise.resolve({ id: 'project-1', taskId: 'task-1' })
const investigation = {
  id: 'case-1', artifactId: 'artifact-1', artifactSha256: 'a'.repeat(64), capability: 'decompile', requestedBy: 'user-1', status: 'QUEUED',
  failureEvidence: {
    providerId: 'ghidra',
    partialProviderOutput: { partialUnits: [{
      type: 'function', key: 'fn:1000', label: 'FUN_1000',
      attributes: { language: 'c', assembly: 'push rbp\nmov rbp, rsp\nret', controlFlow: 'entry -> exit', dataReferences: 'read global_1' },
    }] },
    providerTextEvidence: { fields: [{ field: 'stderr', text: 'provider failed after partial output' }] },
  },
}

describe('POST investigation/run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
    mocks.requireProjectAccess.mockResolvedValue({ projectId: 'project-1' })
    mocks.investigationFindFirst.mockResolvedValue(investigation)
    mocks.providerFindFirst.mockResolvedValue({ id: 'provider-1', name: 'Local LLM', modelIdentifier: 'model-a', timeout: 120 })
    mocks.attemptFindMany.mockResolvedValue([])
    mocks.attemptCreate.mockImplementation(async ({ data }) => ({ id: `attempt-${mocks.attemptCreate.mock.calls.length}`, status: data.status, createdAt: new Date('2026-10-29T10:00:00Z') }))
    mocks.transaction.mockImplementation(async (callback) => callback({
      $queryRaw: mocks.caseLock,
      reamonCodeAttempt: { findMany: mocks.attemptFindMany, create: mocks.attemptCreate },
    }))
  })

  test('queues a durable manual reconstruction using captured evidence and the selected saved provider', async () => {
    const request = new Request('http://local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: 'provider-1', unitKey: 'fn:1000' }) })
    const response = await POST(request, { params })

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      attempt: { id: 'attempt-1', status: 'QUEUED' },
      budget: { usedAttempts: 1, maxAttempts: 24, reservedRuntimeMs: 120_000, maxReservedRuntimeMs: 1_800_000 },
      candidateStatus: 'QUEUED_FOR_RECONSTRUCTION', validationStatus: 'UNAVAILABLE',
    })
    expect(mocks.providerFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'provider-1', userId: 'user-1', providerType: 'openai_compatible' } }))
    const attempt = mocks.attemptCreate.mock.calls[0][0].data
    expect(attempt).toMatchObject({
      projectId: 'project-1', artifactId: 'artifact-1', runKey: 'task-1', codeUnitId: expect.stringMatching(/^investigation:case-1:unit:[a-f0-9]{24}$/),
      scope: 'manual-investigation', status: 'QUEUED', modelIdentifier: 'model-a', language: 'C',
    })
    expect(attempt.requestPayload).toMatchObject({
      model: 'custom/provider-1', user_id: 'user-1', artifact_sha256: 'a'.repeat(64), assembly: 'push rbp\nmov rbp, rsp\nret',
      control_flow: 'entry -> exit', data_references: 'read global_1',
    })
    expect(attempt.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(mocks.caseLock).toHaveBeenCalledOnce()
  })

  test('queues Java reconstruction from bytecode evidence', async () => {
    mocks.investigationFindFirst.mockResolvedValue({
      ...investigation,
      failureEvidence: {
        partialProviderOutput: { partialUnits: [{
          type: 'function', key: 'method:Main.run', label: 'Main.run',
          attributes: { language: 'Java', bytecode: 'iload_0\niadd\nireturn' },
        }] },
      },
    })
    const response = await POST(new Request('http://local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'provider-1', unitKey: 'method:Main.run' }),
    }), { params })

    expect(response.status).toBe(202)
    const attempt = mocks.attemptCreate.mock.calls[0][0].data
    expect(attempt.language).toBe('Java')
    expect(attempt.requestPayload).toMatchObject({ output_language: 'Java', assembly: 'iload_0\niadd\nireturn' })
  })

  test('queues a bounded multi-unit investigation as separate attempts with stable unit identities', async () => {
    mocks.investigationFindFirst.mockResolvedValue({
      ...investigation,
      failureEvidence: {
        partialProviderOutput: { partialUnits: [
          { type: 'function', key: 'fn:1000', label: 'first', attributes: { language: 'c', assembly: 'ret' } },
          { type: 'function', key: 'fn:2000', label: 'second', attributes: { language: 'c', assembly: 'nop\nret' } },
        ] },
      },
    })
    const response = await POST(new Request('http://local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'provider-1', unitKeys: ['fn:1000', 'fn:2000'] }),
    }), { params })

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ attempts: [
      { id: 'attempt-1', status: 'QUEUED' }, { id: 'attempt-2', status: 'QUEUED' },
    ], validationStatus: 'UNAVAILABLE' })
    const created = mocks.attemptCreate.mock.calls.map(([input]) => input.data)
    expect(created).toHaveLength(2)
    expect(created[0].codeUnitId).not.toBe(created[1].codeUnitId)
    expect(created.map((attempt) => attempt.requestPayload.unitKey)).toEqual(['fn:1000', 'fn:2000'])
  })

  test('caps investigation batch size and rejects duplicate unit keys', async () => {
    for (const unitKeys of [Array.from({ length: 6 }, (_, index) => `fn:${index}`), ['fn:1000', 'fn:1000']]) {
      const response = await POST(new Request('http://local', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'provider-1', unitKeys }),
      }), { params })
      expect(response.status).toBe(400)
    }
    expect(mocks.attemptCreate).not.toHaveBeenCalled()
  })

  test('rejects dispatch when the persisted case runtime budget would be exceeded', async () => {
    mocks.attemptFindMany.mockResolvedValue(Array.from({ length: 15 }, (_, index) => ({
      id: `prior-${index}`, codeUnitId: `investigation:case-1:unit:prior${index}`, status: 'FAILED', timeoutMs: 120_000, createdAt: new Date(),
    })))
    const response = await POST(new Request('http://local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'provider-1', unitKey: 'fn:1000' }),
    }), { params })

    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ budget: { maxAttempts: 24, maxReservedRuntimeMs: 1_800_000 } })
    expect(mocks.caseLock).toHaveBeenCalledOnce()
    expect(mocks.attemptCreate).not.toHaveBeenCalled()
  })

  test('rejects dispatch when the attempt-count budget would be exceeded', async () => {
    mocks.attemptFindMany.mockResolvedValue(Array.from({ length: 24 }, (_, index) => ({
      id: `prior-${index}`, codeUnitId: `investigation:case-1:unit:prior${index}`, status: 'FAILED', timeoutMs: 1_000, createdAt: new Date(),
    })))
    const response = await POST(new Request('http://local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'provider-1', unitKey: 'fn:1000' }),
    }), { params })

    expect(response.status).toBe(429)
    expect(mocks.attemptCreate).not.toHaveBeenCalled()
  })

  test('rejects an entire batch when the remaining budget cannot reserve every selected unit', async () => {
    mocks.investigationFindFirst.mockResolvedValue({
      ...investigation,
      failureEvidence: {
        partialProviderOutput: { partialUnits: [
          { type: 'function', key: 'fn:1000', label: 'first', attributes: { language: 'c', assembly: 'ret' } },
          { type: 'function', key: 'fn:2000', label: 'second', attributes: { language: 'c', assembly: 'nop\\nret' } },
        ] },
      },
    })
    mocks.attemptFindMany.mockResolvedValue(Array.from({ length: 23 }, (_, index) => ({
      id: `prior-${index}`, codeUnitId: `investigation:case-1:unit:prior${index}`, status: 'FAILED', timeoutMs: 1_000, createdAt: new Date(),
    })))
    const response = await POST(new Request('http://local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'provider-1', unitKeys: ['fn:1000', 'fn:2000'] }),
    }), { params })

    expect(response.status).toBe(429)
    expect(mocks.attemptCreate).not.toHaveBeenCalled()
  })

  test('returns an already-active unit without consuming a new budget slot', async () => {
    mocks.attemptFindMany.mockResolvedValue([
      ...Array.from({ length: 23 }, (_, index) => ({
        id: `prior-${index}`, codeUnitId: `investigation:case-1:unit:prior${index}`, status: 'FAILED', timeoutMs: 1_000, createdAt: new Date(),
      })),
      { id: 'active-attempt', codeUnitId: `investigation:case-1:unit:${createHash('sha256').update('fn:1000').digest('hex').slice(0, 24)}`, status: 'RUNNING', timeoutMs: 120_000, createdAt: new Date() },
    ])
    const response = await POST(new Request('http://local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'provider-1', unitKey: 'fn:1000' }),
    }), { params })

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ attempts: [{ id: 'active-attempt', status: 'RUNNING' }] })
    expect(mocks.attemptCreate).not.toHaveBeenCalled()
  })

  test('does not accept another user’s provider', async () => {
    mocks.providerFindFirst.mockResolvedValue(null)
    const response = await POST(new Request('http://local', { method: 'POST', body: JSON.stringify({ providerId: 'foreign-provider', unitKey: 'fn:1000' }) }), { params })

    expect(response.status).toBe(404)
    expect(mocks.attemptCreate).not.toHaveBeenCalled()
  })

  test('rejects unsupported task capabilities', async () => {
    mocks.investigationFindFirst.mockResolvedValue({ ...investigation, capability: 'inspect' })
    const response = await POST(new Request('http://local', { method: 'POST', body: JSON.stringify({ providerId: 'provider-1', unitKey: 'fn:1000' }) }), { params })

    expect(response.status).toBe(415)
    expect(mocks.attemptCreate).not.toHaveBeenCalled()
  })

  test('rejects unauthenticated requests before reading saved providers', async () => {
    mocks.requireEffectiveUser.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const response = await POST(new Request('http://local', { method: 'POST', body: JSON.stringify({ providerId: 'provider-1', unitKey: 'fn:1000' }) }), { params })

    expect(response.status).toBe(401)
    expect(mocks.investigationFindFirst).not.toHaveBeenCalled()
  })
})

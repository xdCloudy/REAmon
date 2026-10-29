import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  investigationFindFirst: vi.fn(),
  providerFindFirst: vi.fn(),
  attemptFindFirst: vi.fn(),
  attemptCreate: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  reamonInvestigationCase: { findFirst: mocks.investigationFindFirst },
  userLlmProvider: { findFirst: mocks.providerFindFirst },
  reamonCodeAttempt: { findFirst: mocks.attemptFindFirst, create: mocks.attemptCreate },
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
    mocks.attemptFindFirst.mockResolvedValue(null)
    mocks.attemptCreate.mockImplementation(async ({ data }) => ({ id: 'attempt-1', status: data.status, createdAt: new Date('2026-10-29T10:00:00Z') }))
  })

  test('queues a durable manual reconstruction using captured evidence and the selected saved provider', async () => {
    const request = new Request('http://local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: 'provider-1', unitKey: 'fn:1000' }) })
    const response = await POST(request, { params })

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ attempt: { id: 'attempt-1', status: 'QUEUED' }, candidateStatus: 'QUEUED_FOR_RECONSTRUCTION', validationStatus: 'UNAVAILABLE' })
    expect(mocks.providerFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'provider-1', userId: 'user-1', providerType: 'openai_compatible' } }))
    const attempt = mocks.attemptCreate.mock.calls[0][0].data
    expect(attempt).toMatchObject({
      projectId: 'project-1', artifactId: 'artifact-1', runKey: 'task-1', codeUnitId: 'investigation:case-1',
      scope: 'manual-investigation', status: 'QUEUED', modelIdentifier: 'model-a', language: 'C',
    })
    expect(attempt.requestPayload).toMatchObject({
      model: 'custom/provider-1', user_id: 'user-1', artifact_sha256: 'a'.repeat(64), assembly: 'push rbp\nmov rbp, rsp\nret',
      control_flow: 'entry -> exit', data_references: 'read global_1',
    })
    expect(attempt.sourceHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test('does not accept another user’s provider', async () => {
    mocks.providerFindFirst.mockResolvedValue(null)
    const response = await POST(new Request('http://local', { method: 'POST', body: JSON.stringify({ providerId: 'foreign-provider', unitKey: 'fn:1000' }) }), { params })

    expect(response.status).toBe(404)
    expect(mocks.attemptCreate).not.toHaveBeenCalled()
  })

  test('does not claim support for other languages or missing unit instructions', async () => {
    mocks.investigationFindFirst.mockResolvedValue({ ...investigation, capability: 'disassemble' })
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

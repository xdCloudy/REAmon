/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'

const h = vi.hoisted(() => ({
  user: vi.fn(),
  access: vi.fn(),
  selection: vi.fn(),
  task: vi.fn(),
  observations: vi.fn(),
  sources: vi.fn(),
  reviews: vi.fn(),
  receipt: vi.fn(),
  agentFetch: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ default: {
  task: { findFirst: h.task },
  reamonObservation: { findMany: h.observations, upsert: h.receipt },
  reamonMaintainedSource: { findMany: h.sources },
  reamonCodeReview: { findMany: h.reviews },
} }))
vi.mock('@/lib/access', () => ({ requireEffectiveUser: h.user, requireProjectAccess: h.access }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getActiveWorkspaceImportSelection: h.selection }))
vi.mock('@/lib/agentFetch', () => ({ agentFetch: h.agentFetch }))

import { POST } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }
const sourceCode = 'namespace Sample; public class Pair { public static int Sum(int left, int right) => left + right; }\n'
const sourceHash = createHash('sha256').update(sourceCode).digest('hex')
const receiptHash = 'a'.repeat(64)

beforeEach(() => {
  vi.clearAllMocks()
  h.user.mockResolvedValue({ userId: 'user-1' })
  h.access.mockResolvedValue({ projectId: 'project-1' })
  h.selection.mockResolvedValue({ artifactWhere: { projectId: 'project-1', importId: { in: ['active-import'] } } })
  h.task.mockResolvedValue({ id: 'task-1', artifactId: 'artifact-1', artifact: { id: 'artifact-1' } })
  h.observations.mockResolvedValue([{ id: 'unit-1', attributes: { language: 'C#' } }])
  h.sources.mockResolvedValue([{
    codeUnitId: 'unit-1', sourceCode, sourceHash, acceptedReviewId: 'review-1', relativePath: 'Core/Pair.cs',
  }])
  h.reviews.mockResolvedValue([{ id: 'review-1', codeUnitId: 'unit-1', maintainedSourceHash: sourceHash }])
  h.receipt.mockResolvedValue({ id: 'receipt-observation-1' })
  h.agentFetch.mockResolvedValue(new Response(JSON.stringify({
    source_sha256: receiptHash,
    validation_status: 'PASSED',
    validation_method: 'roslyn-csharp-project-4.11.0-compile',
    validation_message: 'Compiled without executing.',
    compiler_version: '4.11.0',
    compiled_sha256: 'b'.repeat(64),
    file_count: 1,
    files: [{ relative_path: 'Core/Pair.cs', source_sha256: sourceHash }],
  }), { status: 200 }))
})

afterEach(() => vi.restoreAllMocks())

describe('POST /api/projects/[id]/visualizer/maintained/build', () => {
  it('compiles only review-accepted sources and persists the exact build receipt', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'task-1' }),
    }), params)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      receipt: {
        validationStatus: 'PASSED',
        sourceSha256: receiptHash,
        files: [{ codeUnitId: 'unit-1', acceptedReviewId: 'review-1', relativePath: 'Core/Pair.cs', sourceSha256: sourceHash }],
      },
    })
    expect(h.agentFetch).toHaveBeenCalledWith('/reamon/code/compile-project', expect.objectContaining({ method: 'POST' }), { timeoutMs: 35_000 })
    expect(h.receipt).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ artifactId: 'artifact-1', taskId: 'task-1', type: 'project_build_receipt' }),
      update: expect.objectContaining({ isPending: false }),
    }))
  })

  it('rejects source bytes that no longer match their accepted review', async () => {
    h.sources.mockResolvedValue([{
      codeUnitId: 'unit-1', sourceCode, sourceHash: '0'.repeat(64), acceptedReviewId: 'review-1', relativePath: 'Core/Pair.cs',
    }])
    const response = await POST(new Request('http://localhost', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'task-1' }),
    }), params)

    expect(response.status).toBe(409)
    expect(h.agentFetch).not.toHaveBeenCalled()
    expect(h.receipt).not.toHaveBeenCalled()
  })

  it('keeps authentication denials intact', async () => {
    const denied = NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
    h.user.mockResolvedValue(denied)
    const response = await POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ taskId: 'task-1' }) }), params)

    expect(response.status).toBe(401)
    expect(h.task).not.toHaveBeenCalled()
  })
})

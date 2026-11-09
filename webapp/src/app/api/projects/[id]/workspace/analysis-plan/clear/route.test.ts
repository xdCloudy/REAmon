/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccessStrict: vi.fn(),
  getWorkspaceArtifact: vi.fn(),
  resolveCapabilities: vi.fn(),
  getBuiltinProvider: vi.fn(),
  activityCreate: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccessStrict: mocks.requireProjectAccessStrict,
}))
vi.mock('@/lib/prisma', () => ({ default: { workspaceActivity: { create: mocks.activityCreate } } }))
vi.mock('@/lib/reamon/inventory-query', () => ({ getWorkspaceArtifact: mocks.getWorkspaceArtifact }))
vi.mock('@/lib/reamon/capabilities', () => ({ resolveCapabilities: mocks.resolveCapabilities }))
vi.mock('@/lib/reamon/provider-registry', () => ({ getBuiltinProvider: mocks.getBuiltinProvider }))

import { POST } from './route'

const params = { params: Promise.resolve({ id: 'project-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccessStrict.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }))
})

describe('POST /api/projects/[id]/workspace/analysis-plan/clear', () => {
  test('rejects foreign project access before loading or clearing a proposal', async () => {
    const response = await POST(new Request('http://localhost', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalId: 'proposal-1', artifactId: 'artifact-1', providerId: 'provider-1', capability: 'decompile' }),
    }), params)

    expect(response.status).toBe(404)
    expect(mocks.getWorkspaceArtifact).not.toHaveBeenCalled()
    expect(mocks.getBuiltinProvider).not.toHaveBeenCalled()
    expect(mocks.resolveCapabilities).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })
})

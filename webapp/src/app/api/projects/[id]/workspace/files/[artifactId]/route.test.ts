/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  getWorkspaceArtifact: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccessStrict: vi.fn(),
}))

vi.mock('@/lib/reamon/inventory-query', () => ({ getWorkspaceArtifact: mocks.getWorkspaceArtifact }))
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccessStrict: mocks.requireProjectAccessStrict,
}))

import { GET } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccessStrict.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
})

describe('GET /api/projects/[id]/workspace/files/[artifactId]', () => {
  test('requires strict project ownership before loading an artifact', async () => {
    const denied = NextResponse.json({ error: 'Not found' }, { status: 404 })
    mocks.requireProjectAccessStrict.mockResolvedValue(denied)

    const response = await GET(new Request('http://localhost'), { params: Promise.resolve({ id: 'project-1', artifactId: 'artifact-1' }) })

    expect(response).toBe(denied)
    expect(mocks.requireProjectAccessStrict).toHaveBeenCalledWith({ userId: 'user-1' }, 'project-1')
    expect(mocks.getWorkspaceArtifact).not.toHaveBeenCalled()
  })

  test('returns details for an active logical artifact', async () => {
    mocks.getWorkspaceArtifact.mockResolvedValue({
      id: 'artifact-1', relativePath: 'bin/app.exe', capabilities: [], tasks: [], findings: [], hypotheses: [], evidence: [],
    })

    const response = await GET(new Request('http://localhost'), { params: Promise.resolve({ id: 'project-1', artifactId: 'artifact-1' }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'artifact-1', relativePath: 'bin/app.exe' })
    expect(mocks.getWorkspaceArtifact).toHaveBeenCalledWith('project-1', 'artifact-1')
  })

  test('does not reveal historical or inaccessible artifact existence', async () => {
    mocks.getWorkspaceArtifact.mockResolvedValue(null)

    const response = await GET(new Request('http://localhost'), { params: Promise.resolve({ id: 'project-1', artifactId: 'old-artifact' }) })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Workspace artifact not found' })
  })
})

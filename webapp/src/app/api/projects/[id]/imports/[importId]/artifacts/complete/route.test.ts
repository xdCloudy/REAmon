/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireEffectiveUser: vi.fn(),
  requireProjectAccess: vi.fn(),
  commitStagedArtifact: vi.fn(),
}))

vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccess: mocks.requireProjectAccess,
}))

vi.mock('@/lib/reamon/artifact-import-commit', () => ({
  commitStagedArtifact: mocks.commitStagedArtifact,
}))

import { POST } from './route'

function params() {
  return { params: Promise.resolve({ id: 'project-1', importId: 'import-1' }) }
}

function request(): Request {
  return new Request('http://localhost/api/projects/project-1/imports/import-1/artifacts/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath: 'bin/app.exe' }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccess.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
})

describe('POST /api/projects/[id]/imports/[importId]/artifacts/complete', () => {
  test.each([
    ['ENOSPC', Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })],
    ['EDQUOT wrapped by the commit layer', new Error('commit failed', { cause: Object.assign(new Error('quota exceeded'), { code: 'EDQUOT' }) })],
  ])('reports %s as recoverable storage pressure', async (_label, error) => {
    mocks.commitStagedArtifact.mockRejectedValueOnce(error)

    const response = await POST(request(), params())

    expect(response.status).toBe(507)
    expect(await response.json()).toEqual({
      error: 'Artifact storage is full; free space or increase the available volume capacity, then retry',
    })
  })

  test('keeps unrelated validation errors as client errors', async () => {
    mocks.commitStagedArtifact.mockRejectedValueOnce(new Error('Artifact upload is incomplete'))

    const response = await POST(request(), params())

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Artifact upload is incomplete' })
  })
})

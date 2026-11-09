/** @vitest-environment node */
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  requireEffectiveUser: vi.fn(),
  requireProjectAccessStrict: vi.fn(),
}))

vi.mock('@/lib/reamon/workspace-evidence', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reamon/workspace-evidence')>('@/lib/reamon/workspace-evidence')
  return { ...actual, readPersistedWorkspaceEvidence: (...args: unknown[]) => mocks.read(...args) }
})
vi.mock('@/lib/access', () => ({
  requireEffectiveUser: mocks.requireEffectiveUser,
  requireProjectAccessStrict: mocks.requireProjectAccessStrict,
}))

import { WorkspaceEvidenceError } from '@/lib/reamon/workspace-evidence'
import { GET } from './route'

const params = { params: Promise.resolve({ id: 'project-1', evidenceId: 'evidence-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireEffectiveUser.mockResolvedValue({ userId: 'user-1' })
  mocks.requireProjectAccessStrict.mockResolvedValue({ project: { id: 'project-1', userId: 'user-1' } })
  mocks.read.mockResolvedValue({ projectId: 'project-1', evidence: { id: 'evidence-1' }, evidenceHash: 'a'.repeat(64), totalBytes: 5, detailsJson: '{}', hasMore: false })
})

describe('GET /api/projects/[id]/workspace/evidence/[evidenceId]', () => {
  test('returns hash-bound detail bytes after checking ownership', async () => {
    const hash = 'b'.repeat(64)
    const response = await GET(new Request(`http://localhost/api/projects/project-1/workspace/evidence/evidence-1?offsetBytes=131072&evidenceHash=${hash}`), params)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.requireProjectAccessStrict).toHaveBeenCalledWith({ userId: 'user-1' }, 'project-1')
    expect(mocks.read).toHaveBeenCalledWith({ projectId: 'project-1', evidenceId: 'evidence-1', offsetBytes: 131072, evidenceHash: hash })
  })

  test('rejects malformed offsets before reading evidence', async () => {
    for (const offset of ['-1', '1.5', 'NaN', `${32 * 1024 * 1024 + 1}`]) {
      const response = await GET(new Request(`http://localhost/api/projects/project-1/workspace/evidence/evidence-1?offsetBytes=${offset}`), params)
      expect(response.status).toBe(400)
    }
    expect(mocks.read).not.toHaveBeenCalled()
  })

  test('returns the shared stale-evidence response for a changed record', async () => {
    mocks.read.mockRejectedValue(new WorkspaceEvidenceError('Evidence changed while paging.', 'stale_evidence'))

    const response = await GET(new Request('http://localhost/api/projects/project-1/workspace/evidence/evidence-1?offsetBytes=10&evidenceHash=' + 'a'.repeat(64)), params)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'stale_evidence' } })
  })
})
